import {
    Memo,
    TransactionType, 
    MAX_TRANSACTION_TYPE, 
} from "../src"
import { MAX_APP_INDEX } from "../src/memo"

test('TestMemo_Valid', () => {
    const emptyFK = Buffer.alloc(29)

    for (let v = 0; v <= 7; v++) {
        const m = Memo.new(v, TransactionType.Spend, 1, emptyFK)

        expect(m.Version()).toBe(v)
        expect(m.TransactionType()).toBe(TransactionType.Spend)
        expect(m.AppIndex()).toBe(1)
        expect(emptyFK.equals(m.ForeginKey())).toBe(true)
    }

    for (let t = TransactionType.Spend; t < MAX_TRANSACTION_TYPE; t++) {
        const m = Memo.new(1, t, 1, emptyFK)

        expect(m.Version()).toBe(1)
        expect(m.TransactionType()).toBe(t)
        expect(m.AppIndex()).toBe(1)
        expect(emptyFK.equals(m.ForeginKey())).toBe(true)
    }

    // We increment by 0xf instead of 1 since iterating over the total space
    // is far too slow in Javascript (unlike some other languages).
    for (let i = 0; i < MAX_APP_INDEX; i += 0xf) {
        const m = Memo.new(1, TransactionType.Spend, i, emptyFK)

        expect(m.Version()).toBe(1)
        expect(m.TransactionType()).toBe(TransactionType.Spend)
        expect(m.AppIndex()).toBe(i)
        expect(emptyFK.equals(m.ForeginKey())).toBe(true)
    }

    // Test a short foreign key
    const fk = Buffer.alloc(29)
    fk[0] = 1
    const m = Memo.new(1, TransactionType.Earn, 2, fk)
    expect(fk.equals(m.ForeginKey())).toBe(true)

    // Test range of foreign keys
    for (let i = 0; i < 256; i += 29) {
        for (let j = 0; j < 29; j++) {
            fk[j] = i + j
        }

        const m = Memo.new(1, TransactionType.Earn, 2, fk)
        for (let j = 0; j < 28; j++) {
            expect(fk[j]).toBe(m.ForeginKey()[j])
        }

        // Note: because we only have 230 bits, the last byte in the memo fk
        // only has the first 6 bits of the last byte in the original fk.
        expect(fk[28]&0x3f).toBe(m.ForeginKey()[28])
    }
})

test('TestMemo_Invalid', () => {
    const fk = Buffer.alloc(29)

    expect(() => Memo.new(8, TransactionType.Earn, 1, fk)).toThrow("invalid version")

    let m = Memo.new(1, TransactionType.Earn, 1, fk)
    m.buffer[0] = 0xfc
    expect(Memo.IsValid(m)).toBeFalsy()
    expect(Memo.IsValid(m, false)).toBeFalsy()
    expect(Memo.IsValid(m, true)).toBeFalsy()

    // invalid tx type
    m = Memo.new(1, 0, 1, fk)
    expect(Memo.IsValid(m)).toBeFalsy()
    expect(Memo.IsValid(m, false)).toBeFalsy()
    expect(Memo.IsValid(m, true)).toBeFalsy()

    // Version higher than configured
    m = Memo.new(2, TransactionType.Earn, 1, fk)
    expect(Memo.IsValid(m)).toBeTruthy()
    expect(Memo.IsValid(m, false)).toBeTruthy()
    expect(Memo.IsValid(m, true)).toBeFalsy()

    // Transaction type higher than configured
    m = Memo.new(1, MAX_TRANSACTION_TYPE+1, 1, fk)
    expect(Memo.IsValid(m)).toBeTruthy()
    expect(Memo.IsValid(m, false)).toBeTruthy()
    expect(Memo.IsValid(m, true)).toBeFalsy()

})

test('TestMemo_from', () => {
    // Reference strings from Go implementation.
    const valid = Memo.from(Buffer.from("KQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 'base64'))
    expect(Memo.IsValid(valid)).toBeTruthy()
    expect(Memo.IsValid(valid, true)).toBeFalsy()

    const strictlyValid = Memo.from(Buffer.from("JQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", 'base64'))
    expect(Memo.IsValid(strictlyValid)).toBeTruthy()
    expect(Memo.IsValid(strictlyValid, true)).toBeTruthy()
})
