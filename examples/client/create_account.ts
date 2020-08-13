import process from "process";
import { Environment, Client, PrivateKey } from "../../src";

async function run(): Promise<void> {
    const seed = process.env["SEED"];
    if (!seed) {
        return Promise.reject("no seed specified");
    }
    
    const key = PrivateKey.fromString(seed);
    const client = new Client(Environment.Test)
    await client.createAccount(key);
    console.log(`created account with address ${key.publicKey().stellarAddress()}`)
}

run().catch(e => console.log(e));
