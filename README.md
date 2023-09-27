# OAuth Connection Creator for Make

This server helps to create OAuth connections for Make accounts. It's a handy utility that simplifies the process of setting up OAuth connections. 

There is more detailed document if you want to follow the whole process from the start: [LINK](https://dl.dropbox.com/s/b6y9d4et6g9jeux/Create%20an%20OAuth%20connection%20using%20API%20%281%29.pdf)

Watch the full process of connection creation and script walkthrough in this [video](https://www.loom.com/share/c8635ca5736544ee878bdf09e6b411ce).

## Installation & Setup

Follow these steps to get the server up and running:

1. **Set Up Environment Variables**: Rename the `.env.example` file to `.env` and fill in the required credentials.

2. **Install Dependencies**: Navigate into the project directory and install the necessary dependencies using `npm install`:

    ```
    cd <your-repo-name>
    npm install
    ```

3. **Start the Server**: Start the server by running the following command:

    ```
    node server.js
    ```

    Alternatively, if a start script is defined in `package.json`, you can use:

    ```
    npm start
    ```
Now, your server should be up and running!

4. **Open in browser http://server:port page replace this with credentials set in your .env file for example: http://123.456.789.1:777/


## Please pay attention to an API Call for Connection Creation in server.js

The server makes an API call to the Make platform to create a connection. The request to create a connection is done via a `POST` request, which contains a JSON object in the body with properties `accountName`, `accountType`, `scopes`, and others like a custom for each connection `property`. The values for these properties should correspond to the correct account details you want to connect to. You can see this in the code as follows:

```javascript
const createConnectionCall = `${instance}/api/v2/connections?teamId=${teamId}&inspector=1`;

fetch(createConnectionCall, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
        "accountName": "Google Analytics 4 last",
        "accountType": "google-analytics-4",
        "property": "11111"
    })
})


Please note that the `accountName`, `accountType`, and `property` must have correct values according to the [Make API documentation](https://www.make.com/en/api-documentation/connections-post). Failing to provide the correct values may lead to an error response such as:

{
  message: 'The request failed due to failure of a previous request.',
  code: 'SC424',
  suberrors: [
    {
      message: '[403] Error: 403\nThe caller does not have permission',
      name: 'RuntimeError'
    }
  ]
}
