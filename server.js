const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const path = require('path');
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
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Connection endpoint
app.post('/connection', async (req, res) => {
    try {
        const firstURL = `${instance}/api/v2/connections?teamId=${teamId}&inspector=1`;
        const createConnectionResponse = await fetch(firstURL, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
                "accountName": "Google Analytics 4 short version",
                "accountType": "google-analytics-4",
                "property": "11111"
            })
        });
        const createConnection = await createConnectionResponse.json();
        const connection = createConnection.connection;

        const generateConsentURL = `${instance}/api/v2/oauth/auth/${connection.id}`;

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
