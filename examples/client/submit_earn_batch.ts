import process from "process";
import { Environment, Client, PrivateKey, PublicKey, kinToQuarks } from "../../src";

async function run(): Promise<void> {
    const seed = process.env["SENDER_SEED"];
    if (!seed) {
        return Promise.reject("no seed specified");
    }
    const sender = PrivateKey.fromString(seed);

    // A comma delimited set of receivers.
    const destinations = process.env["DESTINATIONS"];
    if (!destinations) {
        return Promise.reject("no destination specified");
    }

    const destKeys = destinations.split(",").map(addr => PublicKey.fromString(addr));

    const client = new Client(Environment.Test, {
        appIndex: 1
    });

    // Send an earn batch with 1 kin each
    let result = await client.submitEarnBatch({
        sender: sender,
        earns: destKeys.map(dest => {
            return {
                destination: dest,
                quarks: kinToQuarks("1"),
            };
        }),
    });

    if (result.txError) {
        console.log(`failed to send earn batch (txId: ${result.txId}): ${result.txError}`);

        if (result.earnErrors) {
            result.earnErrors.forEach(e => {
                console.log(`earn ${e.earnIndex} failed due to: ${e.error}`);
            });
        }
    } else {
        console.log(`successfully sent batch (txId: ${result.txId})`);
    }
    
    // Send an earn batch with 1 kin each, with invoices
    result = await client.submitEarnBatch({
        sender: sender,
        earns: destKeys.map(dest => {
            return {
                destination: dest,
                quarks: kinToQuarks("1"),
                invoice: {
                    Items: [
                        {
                            title: "Example Payment",
                            amount: kinToQuarks("1"),
                        }
                    ],
                }
            };
        })
    });
    
    if (result.txError) {
        console.log(`failed to send earn batch (txId: ${result.txId}): ${result.txError}`);

        if (result.earnErrors) {
            result.earnErrors.forEach(e => {
                console.log(`earn ${e.earnIndex} failed due to: ${e.error}`);
            });
        }
    } else {
        console.log(`successfully sent batch (txId: ${result.txId})`);
    }
}

run().catch(e => console.log(e));
