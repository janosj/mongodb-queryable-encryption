const { MongoClient, Binary } = require("mongodb");
const { ClientEncryption } = require("mongodb-client-encryption");
const { getSecurityConf } = require("./securityConf");
securityConf = getSecurityConf();

const express = require('express')
const path = require('path');
const { exit } = require('process');
const app = express()

// Reconfigured logging to write to console + file.
// Introduced to support troubleshooting on Kubernetes.
var fs = require('fs');
var util = require('util');
var log_file = fs.createWriteStream('debug/debug.log', {flags : 'w'});
var log_stdout = process.stdout;
console.log = function(d) {
    log_file.write(util.format(d) + '\n');
    log_stdout.write(util.format(d) + '\n');
};

// Pick up the MongoDB URI as an environment variable.
uri = process.env.URI;
if (uri) {
    // redact passwords.
    var redacted = uri.replace(/:([a-zA-Z0-9_\.!-]+)@/, ":<redacted>@"); 
    console.log(`Starting app server with MONGODB URI = ${redacted}`);
} else {
    console.log("WARNING! No database connection, MongoDB URI not provided.");
    console.log("Usage: URI=<mdb-uri> node index.js");
    console.log("");
}

const provider = "kmip";
const kmsProviders = {
    kmip: {
        endpoint: securityConf["KMIP_KMS_ENDPOINT"],
    },
};

const keyVaultDBName = securityConf.KEYVAULT_DB;
const keyVaultCollName = securityConf.KEYVAULT_COLLECTION;
const keyVaultNamespace = `${keyVaultDBName}.${keyVaultCollName}`;

const kmipTLSOptions = {
    kmip: {
      tlsCAFile: securityConf.KMIP_TLS_CA_FILE,
      tlsCertificateKeyFile: securityConf.KMIP_TLS_CERT_FILE,
    },
};

// Location of the required Automatic Encryption Shared Library.
const extraOptions = {
    cryptSharedLibPath: securityConf["SHARED_CRYPT_LIB_PATH"],
};

const appDBName = "DEMO";
const appCollName = "workflow";

encryptedFieldsMap = {}

// Queryable Encryption setup.
// Executes once at server startup.
const setupQueryableEncryption = async function() {

    console.log("Initializing Queryable Encryption...");

    const keyVaultClient = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 4000 });
    await keyVaultClient.connect();

    // Drops any pre-existing data keys from previous demo runs.
    const keyVaultDB = keyVaultClient.db(keyVaultDBName);
    await keyVaultDB.dropDatabase();

    // Creates the unique index on the Key Vault collection.
    const keyVaultColl = keyVaultDB.collection(keyVaultCollName);
    await keyVaultColl.createIndex(
        { keyAltNames: 1 },
        {
            unique: true,
            partialFilterExpression: { keyAltNames: { $exists: true } },
        }
    );

    // Create the Data Encryption Key (DEK)
    // An empty key object here prompts the KMIP key provider to generate a new Customer Master Key.
    // The Customer Master Key (CMK) is used to encrypt all the DEKs.
    const masterKey = {}; 
    const clientEnc = new ClientEncryption(keyVaultClient, {
        keyVaultNamespace: keyVaultNamespace,
        kmsProviders: kmsProviders,
        // Note the deviation from the sample code here, to enable renaming the variable.
        // Otherwise, the tls options won't be passed in, resulting in misleading
        // SELF_SIGNED_CERT_IN_CHAIN and BAD_CERTIFICATE errors. 
        // tlsOptions,
        tlsOptions: kmipTLSOptions,
    });
    const dek1 = await clientEnc.createDataKey(provider, {
        masterKey: masterKey,
        keyAltNames: ["dataKey1"],
    });
    console.log("Created key:" + dek1);
    // You could add additional keys here.
    // In this demo we're just encrypting a single field.
    // You could also encrypt multiple fields with a single DEK.
    //const dek2 = await clientEnc.createDataKey(provider, {
    //masterKey: masterKey,
    //keyAltNames: ["dataKey2"],
    //});

    // Create the Encrypted Fields Map for the collection.
    // DO I NEED THIS OR DID I GET IT WHEN IT WAS CREATED?
    const dek1TMP = await keyVaultColl.findOne({ keyAltNames: "dataKey1" });
    console.log("Retrieved key:" + dek1);

    encryptedFieldsMap = {
        [`${appDBName}.${appCollName}`]: {
            fields: [
            {
                keyId: dek1TMP._id,
                path: "approvedBy.ssn",
                bsonType: "string",
                queries: { queryType: "equality" },
            },
            ],
        },
    };

    const encryptedSetupClient = new MongoClient(uri, {
        autoEncryption: {
            keyVaultNamespace: keyVaultNamespace,
            kmsProviders: kmsProviders,
            extraOptions: extraOptions,
            encryptedFieldsMap: encryptedFieldsMap,
            tlsOptions: kmipTLSOptions,
        },
    });
    await encryptedSetupClient.connect();
    
    AppDB = encryptedSetupClient.db(appDBName);
    AppDB.createCollection(appCollName);
    console.log("Created encrypted collection!");

    console.log("Queryable Encryption setup complete.");

}

setupQueryableEncryption().catch(console.dir);
//setupQueryableEncryption();

// **************************************************
// End startup section, begin web server section
// **************************************************

// Note: uses 8081 to leave 8080 available for Ops Manager or anything else.
const port = 8081

app.use(express.static('web'));

// parses incoming json requests and puts parsed data into request.body.
app.use(express.json());

app.get('/', (request, response) => {
    response.sendFile(path.join(__dirname + '/web/index.html'));
})

app.post('/insertDocument', async (request, response) => {

    const MongoClient = require('mongodb').MongoClient;

    const encryptedAppClient = new MongoClient(uri, {
        autoEncryption: {
          keyVaultNamespace: keyVaultNamespace,
          kmsProviders: kmsProviders,
          extraOptions: extraOptions,
          encryptedFieldsMap: encryptedFieldsMap,
          tlsOptions: kmipTLSOptions,
        },
    });
    //await encryptedClient.connect();

    //client.connect().then(
    encryptedAppClient.connect().then(

        function() {

            console.log("\nEstablished database connection.");
            console.log(request.body);

            const collection = encryptedAppClient.db(appDBName).collection(appCollName);

            collection.insertOne(request.body).then( (result) => {
                response.send(JSON.stringify(result));
                console.log('Inserted document.');
                // Not working anymore:
                // TypeError: Cannot read properties of undefined (reading '0')
                //console.log(result.ops[0]);
            }).catch( error => { 
                console.error("Error caught while inserting document:");  
                console.error(error);
                response.status(500).send(error);
            });

        }

    ).catch( (error) => {
        console.error("ERROR in /insertDocument while trying to connect to MongoDB.");
        console.error(error);
        response.status(500).send(error);
    } )

})

app.post('/runQuery', async (request, response) => {

    try {

        console.log("Processing request: /runQuery");
        console.log("Request Body was: " + JSON.stringify(request.body) );

        let queryText = request.body.queryText;
        console.log("Query text is: " + queryText);

        let pageSize = request.body.pageSize;
        let numberToSkip = request.body.pageNumber * pageSize;
        // Return 1 more than the allowed page size, 
        // so the app knows whether to include a "next page" link.
        let pageLimit = pageSize + 1;

        let stageMatch = {
            "$match": { 'approvedBy.ssn': queryText }
        }
        
        // Pagination
        let stageSkip = 
        {
            "$skip": numberToSkip
        }
        let stageLimit = 
        {
            "$limit": pageLimit
        }

        let aggPipeline = [ stageMatch, stageSkip, stageLimit ];

        /* For testing and debugging:
        let stageOut = { "$out": "testOutput" }
        aggPipeline = [ stageSearch, stageIncludeHighlights, stageOut ];
        */

        console.log( "Running pipeline: ", JSON.stringify(aggPipeline) );

        const MongoClient = require('mongodb').MongoClient;

        //const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 4000 });
        const encryptedAppClient = new MongoClient(uri, {
            autoEncryption: {
              keyVaultNamespace: keyVaultNamespace,
              kmsProviders: kmsProviders,
              extraOptions: extraOptions,
              encryptedFieldsMap: encryptedFieldsMap,
              tlsOptions: kmipTLSOptions,
            },
        });
        await encryptedAppClient.connect();
    
        //client.connect().then(
        //encryptedAppClient.connect().then(

            const movies = encryptedAppClient.db(appDBName).collection(appCollName);
            let result = await movies.aggregate( aggPipeline ).toArray();
            //console.log(result);
            response.send(result);
            console.log("Search results delivered to web client.\n");

        //);

    } catch (e) {
        console.log("error caught in index.js (/runQuery):", e.message);
        response.status(500).send({ message: e.message });
    };

});

app.listen(port, () => console.log(`App listening on port ${port}! Access from browser at http://localhost:${port}/`))
