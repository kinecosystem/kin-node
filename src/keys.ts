import {StrKey, Keypair} from "stellar-base"
import base58 from "bs58";

// PublicKey is a blockchain agnostic representation
// of an ed25519 public key.
export class PublicKey {
    buffer: Buffer

    constructor(b: Buffer) {
        this.buffer = b;
    }

    static fromString(address: string): PublicKey {
        if (address.length != 56) {
            throw new Error("address format not supported");
        }

        if (address[0] == "G") {
            return new PublicKey(StrKey.decodeEd25519PublicKey(address));
        }

        throw new Error("address is not a public key");
    }

    stellarAddress(): string {
        return StrKey.encodeEd25519PublicKey(this.buffer);
    }

    equals(other: PublicKey): boolean {
        return this.buffer.equals(other.buffer);
    }
}

// PrivateKey is a blockchain agnostic representation of an
// ed25519 public key.
export class PrivateKey {
    kp: Keypair

    constructor(kp: Keypair) {
        this.kp = kp;
    }

    static random(): PrivateKey {
        return new PrivateKey(Keypair.random());
    }

    static fromString(seed: string): PrivateKey {
        if (seed[0] == "S" && seed.length == 56) {
            return new PrivateKey(Keypair.fromSecret(seed));
        }

        // attempt to parse
        return new PrivateKey(Keypair.fromRawEd25519Seed(Buffer.from(seed, "hex")));
    }

    publicKey(): PublicKey {
        return new PublicKey(this.kp.rawPublicKey());
    }
    stellarSeed(): string {
        return this.kp.secret();
    }

    equals(other: PrivateKey): boolean {
        return this.kp.rawSecretKey().equals(other.kp.rawSecretKey());
    }
}
