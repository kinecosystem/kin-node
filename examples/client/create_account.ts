import process from "process";
import { Client, Environment, PrivateKey } from "../../src";

async function run(): Promise<void> {
    const seed = process.env["SEED"];
    if (!seed) {
        return Promise.reject("no seed specified");
    }
    
    const key = PrivateKey.fromBase58(seed);
    const client = new Client(Environment.Test);
    await client.createAccount(key);
    console.log(`created account with owner ${key.publicKey().toBase58()}`);

    const tokenAccounts = await client.resolveTokenAccounts(key.publicKey());
    for (const tokenAccount of tokenAccounts) {
        const balance = await client.getBalance(tokenAccount);
        console.log(`balance of token account ${tokenAccount.toBase58()}: ${balance}`);
    }
}

run().catch(e => console.log(e));
