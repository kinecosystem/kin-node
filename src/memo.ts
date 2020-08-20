import {xdr} from "stellar-base"
import { TransactionType, MAX_TRANSACTION_TYPE } from "."

const magicByte = 0x1

export const MAX_APP_INDEX = Math.pow(2, 16) - 1
export const MAX_VERSION = 1

// Memo implements the Agora memo specification.
//
// Spec: https://github.com/kinecosystem/agora-api
export class Memo {
    buffer: Buffer
    constructor(buf: Buffer) {
        this.buffer = buf
    }

    static from(b: Buffer): Memo {
        const buf = Buffer.alloc(b.length)
        b.copy(buf)
        return new this(buf)
    }

    static fromXdr(memo: xdr.Memo, strict: boolean): Memo | undefined {
        if (memo.switch() != xdr.MemoType.memoHash()) {
            return undefined
        }

        const m = Memo.from(memo.hash())
        if (!Memo.IsValid(m, strict)) {
            throw new Error("invalid memo")
        }

        return m
    }

    static new(version: number, type: TransactionType, appIndex: number, fk: Buffer): Memo {
        if (fk.length > 29) {
            throw new Error("invalid foreign key length")
        }
        if (version > 7) {
            throw new Error("invalid version")
        }
        if (type == TransactionType.Unknown) {
            throw new Error("cannot use unknown transaction type")
        }

        const b = Buffer.alloc(32)

        // encode magic byte + version
        b[0] = magicByte
        b[0] |= version << 2

        // encode transaction type
        b[0] |= (type & 0x7) << 5
        b[1] = (type & 0x18) >> 3

        // encode AppIndex
        b[1] |= (appIndex & 0x3f) << 2
        b[2] = (appIndex & 0x3fc0) >> 6
        b[3] = (appIndex & 0xc000) >> 14

        if (fk.byteLength > 0) {
            b[3] |= (fk[0] & 0x3f) << 2
            // insert the rest of the fk. since each loop references fk[n] and fk[n+1], the upper bound is offset by 3 instead of 4.
            for (let i = 4; i < 3 + fk.byteLength; i++) {
                // apply last 2-bits of current byte
                // apply first 6-bits of next byte
                b[i] = (fk[i-4] >> 6) & 0x3
                b[i] |= (fk[i-3] & 0x3f) << 2
            }

            // if the foreign key is less than 29 bytes, the last 2 bits of the FK can be included in the memo
            if (fk.byteLength < 29) {
                b[fk.byteLength + 3] = (fk[fk.byteLength-1] >> 6) & 0x3
            }
        }

        return new this(b)
    }

    static IsValid(m: Memo, strict?: boolean): boolean {
        if (Number(m.buffer[0]&0x3) != magicByte) {
            return false
        }

        if (m.TransactionType() == -1) {
            return false
        }

        if (!strict) {
            return true
        }

        if (m.Version() > MAX_VERSION) {
            return false
        }

        return m.TransactionType() <= MAX_TRANSACTION_TYPE
    }

    // Version returns the memo encoding version.
    Version(): number {
        return (this.buffer[0] & 0x1c) >> 2
    }

    // TransactionType returns the type of the transaction the memo is
    // attached to.
    TransactionType(): TransactionType {
        return (this.buffer[0] >> 5) | (this.buffer[1]&0x3)<<3
    }

    // AppIndex returns the index of the app the transaction relates to.
    AppIndex(): number {
        const a = Number(this.buffer[1]) >> 2
        const b = Number(this.buffer[2]) << 6
        const c = Number(this.buffer[3] & 0x3) << 14
        return a | b | c
    }

    // ForeignKey returns an identifier in an auxiliary service that contains
    // additional information related to the transaction.
    ForeginKey(): Buffer {
        const fk = Buffer.alloc(29)

        for (let i = 0; i < 28; i++) {
            fk[i] |= this.buffer[i+3] >> 2
            fk[i] |= (this.buffer[i+4] & 0x3) << 6
        }

        // We only have 230 bits, which results in
        // our last fk byte only having 6 'valid' bits
        fk[28] = this.buffer[31] >> 2

        return fk
    }
}
