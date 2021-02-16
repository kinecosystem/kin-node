import process from "process";
import { Environment, Client, PrivateKey, PublicKey, kinToQuarks, TransactionType, Payment, EarnBatch, EarnBatchResult } from "../../src";
import { v4 as uuidv4 } from "uuid";

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
        appIndex: 1,
    });

    // Send a payment with a dedupeId
    const payment: Payment = {
        sender: sender,
        destination: destKeys[0],
        type: TransactionType.None,
        quarks: kinToQuarks("1"),
        dedupeId: Buffer.from(uuidv4()),
    };
    
    let txId: Buffer;
    try {
        txId = await client.submitPayment(payment);
        console.log(`payment with dedupeId ${payment.dedupeId} succeeded with txId ${txId}`);
    } catch (error) {
        console.log(`payment with dedupeId ${payment.dedupeId} failed due to unexpected error, safe to retry since dedupeId was set`);
        txId = await client.submitPayment(payment);
        console.log(`payment with dedupeId ${payment.dedupeId} succeeded with txId ${txId}`);
    }

    // Send an earn batch with a dedupeId
    const batch: EarnBatch = {
        sender: sender,
        earns: destKeys.map(dest => {
            return {
                destination: dest,
                quarks: kinToQuarks("1"),
            };
        }),
        dedupeId: Buffer.from(uuidv4()),
    };
    
    let result: EarnBatchResult;
    try {
         result = await client.submitEarnBatch(batch);
         logBatchResult(batch, result);
    } catch (error) {
        console.log(`earn batch with dedupeId ${batch.dedupeId} failed due to unexpected error, safe to retry since dedupeId was set`);
        result = await client.submitEarnBatch(batch);
        logBatchResult(batch, result);
    }
}

function logBatchResult(batch: EarnBatch, result: EarnBatchResult) {
    if (result.txError) {
        console.log(`failed to send earn batch with dedupeId ${batch.dedupeId} (txId: ${result.txId}): ${result.txError}`);

        if (result.earnErrors) {
            result.earnErrors.forEach(e => {
                console.log(`earn ${e.earnIndex} failed due to: ${e.error}`);
            });
        }
    } else {
        console.log(`successfully sent eacn batch with dedupeId ${batch.dedupeId} (txId: ${result.txId})`);
    }
}

run().catch(e => console.log(e));
