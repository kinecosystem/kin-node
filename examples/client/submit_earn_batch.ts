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
            }
        })
    })
    for (let r of result.succeeded) {
        console.log(`successfully sent 1 kin to ${r.earn.destination.stellarAddress()}`)
    }
    for (let r of result.failed) {
        console.log(`failed to send 1 kin to ${r.earn.destination.stellarAddress()}`)
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
            }
        })
    })
    for (let r of result.succeeded) {
        console.log(`successfully sent 1 kin to ${r.earn.destination.stellarAddress()}`)
    }
    for (let r of result.failed) {
        console.log(`failed to send 1 kin to ${r.earn.destination.stellarAddress()}`)
    }
}

run().catch(e => console.log(e));
