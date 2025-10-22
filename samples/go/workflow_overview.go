// Simplified Make connection workflow in Go.
//
// This single file mirrors the Node sample so teams can understand the control flow,
// API payloads, and blueprint rewriting without digging through a larger codebase.
//
// Usage:
//   go run workflow_overview.go "Hubspot - FBcapi.json" "Optional Account Name"
package main

import (
    "bufio"
    "bytes"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net/http"
    "net/url"
    "os"
    "os/exec"
    "path/filepath"
    "runtime"
    "strings"
)

var rootDir = func() string {
    dir, _ := filepath.Abs(filepath.Join(filepath.Dir(os.Args[0]), "..", ".."))
    return dir
}()

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage: go run workflow_overview.go <blueprint.json> [account-name]")
        os.Exit(1)
    }

    blueprintName := os.Args[1]
    accountOverride := ""
    if len(os.Args) > 2 {
        accountOverride = os.Args[2]
    }

    env, err := loadEnv(filepath.Join(rootDir, ".env"))
    if err != nil {
        panic(err)
    }

    settings := Settings{
        InstanceURL:  firstNonEmpty(env["INSTANCE_URL"], os.Getenv("INSTANCE_URL")),
        AuthToken:    firstNonEmpty(env["AUTH_TOKEN"], os.Getenv("AUTH_TOKEN")),
        TeamID:       firstNonEmpty(env["TEAM_ID"], os.Getenv("TEAM_ID")),
        BlueprintDir: filepath.Join(rootDir, "blueprints"),
        UpdatedDir:   filepath.Join(rootDir, "samples", "go"),
    }

    if err := ensureSettings(settings); err != nil {
        panic(err)
    }

    blueprint, blueprintPath, err := loadBlueprint(settings, blueprintName)
    if err != nil {
        panic(err)
    }

    appName, modules := analyseBlueprint(blueprint)
    appDefinition, err := fetchJSON(settings, fmt.Sprintf("/api/v2/imt/apps/%s", appName), "GET", nil)
    if err != nil {
        panic(err)
    }
    scopes := collectScopes(appDefinition, modules)
    formSchema, err := fetchJSON(settings, fmt.Sprintf("/api/v2/imt-forms/connections/create?type=%s&teamId=%s", appName, settings.TeamID), "GET", nil)
    if err != nil {
        panic(err)
    }
    payload := buildPayload(formSchema, appName, scopes, accountOverride)

    createResp, err := fetchJSON(settings, fmt.Sprintf("/api/v2/connections?teamId=%s&inspector=0", settings.TeamID), "POST", payload)
    if err != nil {
        panic(err)
    }
    connection, ok := createResp["connection"].(map[string]interface{})
    if !ok {
        connection = createResp
    }
    if _, ok := connection["id"]; !ok {
        panic("connection response missing id")
    }

    consentURL, err := fetchConsentURL(settings, connection["id"])
    if err != nil {
        panic(err)
    }

    rewritten, updated := rewriteBlueprint(blueprint, connection["id"])
    path, err := saveBlueprint(settings, blueprintPath, rewritten)
    if err != nil {
        panic(err)
    }

    fmt.Println("Connection created:", connection["id"])
    fmt.Println("Consent URL:", consentURL)
    fmt.Printf("Updated blueprint (%d modules): %s\n", updated, path)

    openBrowser(consentURL)
    fmt.Print("Complete consent, then press Enter to run the connection test...")
    bufio.NewReader(os.Stdin).ReadBytes('\n')

    testResp, err := fetchJSON(settings, fmt.Sprintf("/api/v2/connections/%v/test", connection["id"]), "POST", nil)
    if err != nil {
        panic(err)
    }
    pretty, _ := json.MarshalIndent(testResp, "", "  ")
    fmt.Println(string(pretty))
}

// Settings keeps configuration together so we do not pass dozens of arguments around.
type Settings struct {
    InstanceURL  string
    AuthToken    string
    TeamID       string
    BlueprintDir string
    UpdatedDir   string
}

// loadEnv reads a minimal .env file (key=value) without external dependencies.
func loadEnv(path string) (map[string]string, error) {
    env := make(map[string]string)
    file, err := os.Open(path)
    if err != nil {
        if errors.Is(err, os.ErrNotExist) {
            return env, nil
        }
        return nil, err
    }
    defer file.Close()

    scanner := bufio.NewScanner(file)
    for scanner.Scan() {
        line := strings.TrimSpace(scanner.Text())
        if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
            continue
        }
        parts := strings.SplitN(line, "=", 2)
        env[strings.TrimSpace(parts[0])] = strings.Trim(strings.TrimSpace(parts[1]), "\"")
    }
    return env, scanner.Err()
}

// ensureSettings validates that the inputs required by every Make API call exist.
func ensureSettings(settings Settings) error {
    missing := make([]string, 0)
    if settings.InstanceURL == "" {
        missing = append(missing, "INSTANCE_URL")
    }
    if settings.AuthToken == "" {
        missing = append(missing, "AUTH_TOKEN")
    }
    if settings.TeamID == "" {
        missing = append(missing, "TEAM_ID")
    }
    if len(missing) > 0 {
        return fmt.Errorf("missing required env vars: %s", strings.Join(missing, ", "))
    }
    return nil
}

// fetchJSON performs an HTTP request against the Make API and decodes JSON responses.
func fetchJSON(settings Settings, path string, method string, body interface{}) (map[string]interface{}, error) {
    url := strings.TrimSuffix(settings.InstanceURL, "/") + path
    var reqBody io.Reader
    if body != nil {
        raw, err := json.Marshal(body)
        if err != nil {
            return nil, err
        }
        reqBody = bytes.NewReader(raw)
    }
    req, err := http.NewRequest(method, url, reqBody)
    if err != nil {
        return nil, err
    }
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Token "+settings.AuthToken)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode >= 300 {
        bodyBytes, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("request failed (%d): %s", resp.StatusCode, string(bodyBytes))
    }

    var data map[string]interface{}
    decoder := json.NewDecoder(resp.Body)
    if err := decoder.Decode(&data); err != nil {
        return nil, err
    }
    return data, nil
}

// fetchConsentURL requests the browser redirect URL without following the redirect.
func fetchConsentURL(settings Settings, connectionID interface{}) (string, error) {
    path := fmt.Sprintf("/api/v2/oauth/auth/%v", connectionID)
    url := strings.TrimSuffix(settings.InstanceURL, "/") + path
    req, err := http.NewRequest("GET", url, nil)
    if err != nil {
        return "", err
    }
    req.Header.Set("Authorization", "Token "+settings.AuthToken)

    client := &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
        return http.ErrUseLastResponse
    }}
    resp, err := client.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    if resp.StatusCode < 300 || resp.StatusCode >= 400 {
        return "", fmt.Errorf("unexpected status %d when requesting consent", resp.StatusCode)
    }
    location := resp.Header.Get("Location")
    if location == "" {
        return "", errors.New("missing Location header")
    }
    return location, nil
}

// loadBlueprint accepts either an absolute path or a filename inside the blueprint directory.
func loadBlueprint(settings Settings, name string) (map[string]interface{}, string, error) {
    candidates := []string{
        name,
        filepath.Join(settings.BlueprintDir, name),
    }
    for _, candidate := range candidates {
        if data, err := os.ReadFile(candidate); err == nil {
            var blueprint map[string]interface{}
            if err := json.Unmarshal(data, &blueprint); err != nil {
                return nil, "", err
            }
            return blueprint, candidate, nil
        }
    }
    return nil, "", fmt.Errorf("blueprint not found: %s", name)
}

// rewriteBlueprint clones the blueprint and swaps __IMTCONN__ for every non-Facebook module.
func rewriteBlueprint(blueprint map[string]interface{}, connectionID interface{}) (map[string]interface{}, int) {
    raw, _ := json.Marshal(blueprint)
    clone := make(map[string]interface{})
    json.Unmarshal(raw, &clone)
    updated := 0

    var walk func(interface{})
    walk = func(node interface{}) {
        switch v := node.(type) {
        case []interface{}:
            for _, item := range v {
                walk(item)
            }
        case map[string]interface{}:
            if module, ok := v["module"].(string); ok && !strings.HasPrefix(module, "facebook-conversion-leads") {
                if params, ok := v["parameters"].(map[string]interface{}); ok {
                    if _, exists := params["__IMTCONN__"]; exists {
                        params["__IMTCONN__"] = connectionID
                        updated++
                    }
                }
            }
            for _, value := range v {
                walk(value)
            }
        }
    }

    walk(clone["flow"])
    return clone, updated
}

// saveBlueprint writes the rewritten JSON next to the sample file to keep everything portable.
func saveBlueprint(settings Settings, original string, blueprint map[string]interface{}) (string, error) {
    if err := os.MkdirAll(settings.UpdatedDir, 0o755); err != nil {
        return "", err
    }
    base := strings.TrimSuffix(filepath.Base(original), filepath.Ext(original))
    path := filepath.Join(settings.UpdatedDir, base+"-updated.json")
    data, err := json.MarshalIndent(blueprint, "", "  ")
    if err != nil {
        return "", err
    }
    if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
        return "", err
    }
    return path, nil
}

// openBrowser triggers the platform specific command to launch the consent URL.
func openBrowser(rawURL string) {
    if _, err := url.ParseRequestURI(rawURL); err != nil {
        fmt.Println("Invalid consent URL:", rawURL)
        return
    }
    var cmd *exec.Cmd
    switch runtime.GOOS {
    case "darwin":
        cmd = exec.Command("open", rawURL)
    case "windows":
        cmd = exec.Command("cmd", "/c", "start", rawURL)
    default:
        cmd = exec.Command("xdg-open", rawURL)
    }
    _ = cmd.Start()
}

// analyseBlueprint extracts the target app and module names from the blueprint tree.
func analyseBlueprint(blueprint map[string]interface{}) (string, []string) {
    modules := make([][2]string, 0)
    var walk func(interface{})
    walk = func(node interface{}) {
        switch v := node.(type) {
        case []interface{}:
            for _, item := range v {
                walk(item)
            }
        case map[string]interface{}:
            if module, ok := v["module"].(string); ok {
                parts := strings.SplitN(module, ":", 2)
                if len(parts) == 2 {
                    modules = append(modules, [2]string{parts[0], parts[1]})
                }
            }
            for _, value := range v {
                walk(value)
            }
        }
    }
    walk(blueprint["flow"])

    for _, pair := range modules {
        if pair[0] != "facebook-conversion-leads" {
            selectedApp := pair[0]
            moduleNames := make([]string, 0)
            for _, candidate := range modules {
                if candidate[0] == selectedApp {
                    moduleNames = append(moduleNames, candidate[1])
                }
            }
            return selectedApp, moduleNames
        }
    }
    panic("no eligible modules found")
}

// collectScopes maps blueprint modules to scopes listed in the Make app definition.
func collectScopes(appDefinition map[string]interface{}, moduleNames []string) []string {
    lookup := make(map[string][]string)
    app := appDefinition["app"].(map[string]interface{})
    for _, bucket := range []string{"actions", "searches", "triggers"} {
        items, _ := app[bucket].([]interface{})
        for _, raw := range items {
            item := raw.(map[string]interface{})
            name, _ := item["name"].(string)
            if name == "" {
                continue
            }
            if scopes, ok := item["scopes"].([]interface{}); ok {
                lookup[strings.ToLower(name)] = toStringSlice(scopes)
            }
        }
    }
    combined := make(map[string]struct{})
    for _, name := range moduleNames {
        for _, scope := range lookup[strings.ToLower(name)] {
            combined[scope] = struct{}{}
        }
    }
    result := make([]string, 0, len(combined))
    for scope := range combined {
        result = append(result, scope)
    }
    return result
}

// buildPayload merges default form values with our account override and scoped permissions.
func buildPayload(schema map[string]interface{}, appName string, scopes []string, override string) map[string]interface{} {
    payload := make(map[string]interface{})
    fields := make([]map[string]interface{}, 0)

    var walk func(interface{})
    walk = func(node interface{}) {
        switch v := node.(type) {
        case []interface{}:
            for _, item := range v {
                walk(item)
            }
        case map[string]interface{}:
            key := ""
            if k, ok := v["key"].(string); ok && k != "" {
                key = k
            } else if name, ok := v["name"].(string); ok && name != "" {
                key = name
            }

            resolvedType := ""
            if t, ok := v["type"].(string); ok && t != "" {
                resolvedType = t
            } else if templ, ok := v["templateOptions"].(map[string]interface{}); ok {
                if t, ok := templ["type"].(string); ok {
                    resolvedType = t
                }
            }

            if key != "" {
                lowerType := strings.ToLower(resolvedType)
                if lowerType != "button" && lowerType != "content" && lowerType != "htmlelement" {
                    field := map[string]interface{}{
                        "key":              key,
                        "type":             resolvedType,
                        "data":             v["data"],
                        "templateOptions":  v["templateOptions"],
                        "defaultValue":     nil,
                    }
                    if defVal, ok := v["defaultValue"]; ok {
                        field["defaultValue"] = defVal
                    } else if templ, ok := v["templateOptions"].(map[string]interface{}); ok {
                        if dv, ok := templ["defaultValue"]; ok {
                            field["defaultValue"] = dv
                        } else if dv, ok := templ["default"]; ok {
                            field["defaultValue"] = dv
                        }
                    }
                    if field["defaultValue"] == nil {
                        if dv, ok := v["default"]; ok {
                            field["defaultValue"] = dv
                        }
                    }
                    fields = append(fields, field)
                }
            }

            for prop, value := range v {
                if prop == "components" {
                    continue
                }
                if prop == "options" {
                    if optMap, ok := value.(map[string]interface{}); ok {
                        if store, ok := optMap["store"].([]interface{}); ok && len(store) > 0 {
                            var selected map[string]interface{}
                            for _, candidate := range store {
                                option, ok := candidate.(map[string]interface{})
                                if !ok {
                                    continue
                                }
                                if def, ok := option["default"].(bool); ok && def {
                                    selected = option
                                    break
                                }
                                if sel, ok := option["selected"].(bool); ok && sel {
                                    selected = option
                                    break
                                }
                                if selected == nil {
                                    selected = option
                                }
                            }
                            if selected != nil {
                                walk(selected)
                            }
                            continue
                        }
                    }
                }
                if prop == "nested" {
                    if arr, ok := value.([]interface{}); ok {
                        for _, item := range arr {
                            walk(item)
                        }
                        continue
                    }
                }
                walk(value)
            }
        }
    }
    walk(schema)

    for _, field := range fields {
        key := field["key"].(string)
        if val, ok := field["defaultValue"]; ok && val != nil {
            payload[key] = val
        } else {
            payload[key] = fallbackForField(field)
        }
    }

    if name, ok := payload["accountName"].(string); ok {
        if strings.Contains(name, "{{") && strings.Contains(name, "}}") {
            payload["accountName"] = ""
        }
    }

    if payload["accountType"] == nil || payload["accountType"] == "" {
        payload["accountType"] = appName
    }
    if override != "" {
        payload["accountName"] = override
    } else if payload["accountName"] == nil || payload["accountName"] == "" {
        payload["accountName"] = appName + " connection"
    }
    payload["customScopes"] = scopes
    if val, ok := payload["property"]; ok && val == "" {
        panic("the connection form expects a property value")
    }
    return payload
}

// toStringSlice converts interface{} lists coming from JSON into []string for convenience.
func toStringSlice(items []interface{}) []string {
    result := make([]string, 0, len(items))
    for _, item := range items {
        if s, ok := item.(string); ok {
            result = append(result, s)
        }
    }
    return result
}

// firstNonEmpty returns the first non-empty string in the provided list.
func firstNonEmpty(values ...string) string {
    for _, v := range values {
        if strings.TrimSpace(v) != "" {
            return v
        }
    }
    return ""
}

func fallbackForField(field map[string]interface{}) interface{} {
    typeStr, _ := field["type"].(string)
    template, _ := field["templateOptions"].(map[string]interface{})
    if typeStr != "" && strings.EqualFold(typeStr, "boolean") {
        return false
    }
    if template != nil {
        if templType, _ := template["type"].(string); templType != "" && strings.EqualFold(templType, "boolean") {
            return false
        }
    }
    if value, ok := optionFallback(field, template); ok {
        return value
    }
    return ""
}

func optionFallback(field map[string]interface{}, template map[string]interface{}) (interface{}, bool) {
    sources := []map[string]interface{}{}
    if data, _ := field["data"].(map[string]interface{}); data != nil {
        sources = append(sources, data)
    }
    if template != nil {
        sources = append(sources, template)
    }
    if len(sources) == 0 {
        return nil, false
    }

    for _, source := range sources {
        if val, exists := source["defaultValue"]; exists {
            return val, true
        }
    }

    for _, source := range sources {
        for _, key := range []string{"options", "values", "items", "enum"} {
            raw, exists := source[key]
            if !exists {
                continue
            }

            candidates := make([]interface{}, 0)
            switch typed := raw.(type) {
            case []interface{}:
                candidates = append(candidates, typed...)
            case map[string]interface{}:
                if store, ok := typed["store"].([]interface{}); ok {
                    candidates = append(candidates, store...)
                }
            }

            if len(candidates) == 0 {
                continue
            }

            var preferred interface{}
            for _, item := range candidates {
                if option, ok := item.(map[string]interface{}); ok {
                    if def, ok := option["default"].(bool); ok && def {
                        preferred = item
                        break
                    }
                    if sel, ok := option["selected"].(bool); ok && sel {
                        preferred = item
                        break
                    }
                    if preferred == nil {
                        preferred = item
                    }
                } else if preferred == nil {
                    preferred = item
                }
            }

            selected := candidates
            if preferred != nil {
                selected = []interface{}{preferred}
            }

            for _, item := range selected {
                if option, ok := item.(map[string]interface{}); ok {
                    for _, candidate := range []string{"value", "id", "code"} {
                        if val, ok := option[candidate]; ok {
                            return val, true
                        }
                    }
                } else if item != nil {
                    return item, true
                }
            }
        }
    }
    return nil, false
}
