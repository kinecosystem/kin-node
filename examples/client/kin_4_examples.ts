import BigNumber from "bignumber.js";
import base58 from "bs58";
import { Environment, Client, PrivateKey, PublicKey, kinToQuarks, TransactionType } from "../../src";

async function run(): Promise<void> {
    const client = new Client(Environment.Test, {
        appIndex: 1,
        kinVersion: 4,
    });

    const sender = PrivateKey.random();
    const account_id = sender.publicKey().toBase58();

    // Create an account
    console.log(`creating account (b58-encoded private key: ${base58.encode(sender.kp.rawSecretKey())}, account id: ${account_id})`);
    try {
        await client.createAccount(sender);
        console.log('account created');
    } catch (error) {
        console.log(`failed to create account: ${error}`);
        return;
    }

    // Request an airdrop (test env only)
    console.log(`requesting airdrop for ${account_id}`);
    try {
        const airdropTxId  = await client.internal.requestAirdrop(sender.publicKey(), new BigNumber(5e5));
        console.log(`funded ${account_id} with 5 Kin (sig: ${base58.encode(airdropTxId)})`);
    } catch (error) {
        console.log(`failed to airdrop to account: ${error}`);
        return;
    }

    // Use airdrop source as destination
    const airdropSource = PublicKey.fromBase58("DemXVWQ9DXYsGFpmjFXxki3PE1i3VoHQtqxXQFx38pmU");

    // Send a payment of 1 Kin
    try {
        const txId = await client.submitPayment({
            sender: sender,
            destination: airdropSource,
            type: TransactionType.Spend,
            quarks: kinToQuarks("1"),
        });
        console.log(`send 1 Kin to ${airdropSource.toBase58()} (sig: ${base58.encode(txId)})`);
    } catch (error) {
        console.log(`failed to send payment to source: ${error}`);
    }

    // Send an earn batch with 1 kin each
    const result = await client.submitEarnBatch({
        sender: sender,
        earns: [
            {
                destination: airdropSource,
                quarks: kinToQuarks("1"),
            },
            {
                destination: airdropSource,
                quarks: kinToQuarks("1"),
            },
        ]
    });
    for (const earnResult of result.succeeded) {
        console.log(`successfully sent 1 kin to ${earnResult.earn.destination.toBase58()}`);
    }
    for (const earnResult of result.failed) {
        console.log(`failed to send 1 kin to ${earnResult.earn.destination.toBase58()}`);
    }
}

run().catch(e => console.log(e));
