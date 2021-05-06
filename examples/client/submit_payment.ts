import bs58 from "bs58";
import process from "process";
import { Environment, Client, PrivateKey, PublicKey, TransactionType, kinToQuarks } from "../../src";

async function run(): Promise<void> {
    const seed = process.env["SENDER_SEED"];
    if (!seed) {
        return Promise.reject("no seed specified");
    }
    const destination = process.env["DESTINATION"];
    if (!destination) {
        return Promise.reject("no destination specified");
    }
    
    const sender = PrivateKey.fromString(seed);
    const dest = PublicKey.fromString(destination);

    const client = new Client(Environment.Test, {
        appIndex: 1
    });

    // Send 1 kin.
    let txId = await client.submitPayment({
        sender: sender,
        destination: dest,
        type: TransactionType.Spend,
        quarks: kinToQuarks("1"),
    });
    console.log(`tx: ${bs58.encode(txId)}`);

    // Send 1 kin with a text memo.
    txId = await client.submitPayment({
        sender: sender,
        destination: dest,
        type: TransactionType.Spend,
        quarks: kinToQuarks("1"),
        memo: "1-test"
    });
    console.log(`tx: ${bs58.encode(txId)}`);

    // Send 1 kin with an invoice
    txId = await client.submitPayment({
        sender: sender,
        destination: dest,
        type: TransactionType.Spend,
        quarks: kinToQuarks("1"),
        invoice: {
            Items: [
                {
                    title: "TestPayment",
                    description: "Optional desc about the payment",
                    amount: kinToQuarks("1"),
                    sku: Buffer.from("hello", 'utf-8'),
                },
            ],
        },
    });
    console.log(`tx: ${bs58.encode(txId)}`);
}

run().catch(e => console.log(e));
