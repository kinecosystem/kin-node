import { sha256 } from "hash.js";
import { Keypair } from "stellar-base";
import { PrivateKey } from "..";

export function generateTokenAccount(key: PrivateKey): PrivateKey {
    return new PrivateKey(Keypair.fromRawEd25519Seed(Buffer.from(sha256().update(key.kp.rawSecretKey()).digest())));
}
