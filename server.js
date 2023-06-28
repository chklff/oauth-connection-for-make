const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Define constants using environment variables
const instance = process.env.INSTANCE_URL;
const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Token ${process.env.AUTH_TOKEN}`,
};
const teamId = process.env.TEAM_ID;

// Middleware for parsing JSON bodies
app.use(bodyParser.json());

// Serve the HTML file if there are no query parameters
// app.get('/', (req, res) => {
//     res.sendFile(path.join(__dirname, 'index.html'));
// });

app.get('/', (req, res) => {
    // Read the environment variables
    const port = process.env.PORT || 777;
    const host = process.env.HOST || 'http://localhost';

    // Read the index.html file into a string
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

    // Replace placeholders in the HTML with the environment variables
    html = html.replace(/{{HOST}}/g, host).replace(/{{PORT}}/g, port);

    // Send the modified HTML to the client
    res.send(html);
});

// Connection endpoint
app.post('/connection', async (req, res) => {
    try {
        const createConnectionCall = `${instance}/api/v2/connections?teamId=${teamId}&inspector=1`;
        const createConnectionResponse = await fetch(createConnectionCall, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
                "accountName": "Google Analytics 4 last",
                "accountType": "google-analytics-4",
                "property": "11111"
            })
        });
        const createConnection = await createConnectionResponse.json();
        const connection = createConnection.connection;
        console.log(createConnection)

        const generateConsentURL = `${instance}/api/v2/oauth/auth/${connection.id}`;
        console.log(generateConsentURL)

        const secondResponse = await fetch(generateConsentURL, {
            method: 'GET',
            headers: authHeaders,
            redirect: 'manual',
        });
        const url = secondResponse.headers.get('location');

        res.json({ url, connectionId: connection.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Test endpoint
app.post('/test', async (req, res) => {
    try {
        const { connection } = req.body;
        const testURL = `${instance}/api/v2/connections/${connection}/test`;

        const testConnection = await fetch(testURL, {
            method: 'POST',
            headers: authHeaders,
        });
        const responseBody = await testConnection.json();
        console.log(responseBody)

        res.json({ result: responseBody });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Starting the server
const port = process.env.PORT || 777;
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});
