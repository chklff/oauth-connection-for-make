# OAuth Connection Creator for Make

This server helps to create OAuth connections for Make accounts. It's a handy utility that simplifies the process of setting up OAuth connections. 

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
