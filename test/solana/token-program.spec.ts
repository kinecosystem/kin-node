import { AuthorityType, Command, InitializeAccountParams, SetAuthorityParams, TokenInstruction, TokenProgram, TransferParams } from "../../src/solana/token-program"
import { PrivateKey } from "../../src/keys"

const tokenProgram = PrivateKey.random().publicKey().solanaKey();

test('TestTokenProgram_InitializeAccount', () => {
    const params: InitializeAccountParams = {
        account: PrivateKey.random().publicKey().solanaKey(),
        mint: PrivateKey.random().publicKey().solanaKey(),
        owner: PrivateKey.random().publicKey().solanaKey(),
    }
    const instruction = TokenProgram.initializeAccount(params, tokenProgram)
    expect(instruction.data).toHaveLength(1)
    expect(instruction.data[0]).toEqual(Command.InitializeAccount)

    expect(instruction.keys).toHaveLength(4)
    expect(instruction.keys[0].pubkey.toBase58()).toBe(params.account.toBase58())
    expect(instruction.keys[0].isSigner).toBeTruthy()
    expect(instruction.keys[0].isWritable).toBeTruthy()

    const expectedKeys = [params.mint, params.owner, TokenProgram.rentSysVar]
    for (let i = 1; i < 4; i++) {
        expect(instruction.keys[i].pubkey.toBase58()).toBe(expectedKeys[i-1].toBase58())
        expect(instruction.keys[i].isSigner).toBeFalsy()
        expect(instruction.keys[i].isWritable).toBeFalsy()
    }

    expect(params).toEqual(
        TokenInstruction.decodeInitializeAccount(instruction, tokenProgram)
    )
})

test('TestTokenProgram_Transfer', () => {
    const params: TransferParams = {
        source: PrivateKey.random().publicKey().solanaKey(),
        dest: PrivateKey.random().publicKey().solanaKey(),
        owner: PrivateKey.random().publicKey().solanaKey(),
        amount: BigInt(123456789),
    }
    const instruction = TokenProgram.transfer(params, tokenProgram)
    expect(instruction.data).toHaveLength(9)
    expect(instruction.data[0]).toEqual(Command.Transfer)

    expect(instruction.keys).toHaveLength(3)
    expect(instruction.keys[0].pubkey.toBase58()).toBe(params.source.toBase58())
    expect(instruction.keys[0].isSigner).toBeFalsy()
    expect(instruction.keys[0].isWritable).toBeTruthy()
    expect(instruction.keys[1].pubkey.toBase58()).toBe(params.dest.toBase58())
    expect(instruction.keys[1].isSigner).toBeFalsy()
    expect(instruction.keys[1].isWritable).toBeTruthy()
    expect(instruction.keys[2].pubkey.toBase58()).toBe(params.owner.toBase58())
    expect(instruction.keys[2].isSigner).toBeTruthy()
    expect(instruction.keys[2].isWritable).toBeTruthy()

    expect(params).toEqual(
        TokenInstruction.decodeTransfer(instruction, tokenProgram)
    )
})


test('TestTokenProgram_SetAuthority', () => {
    let params: SetAuthorityParams = {
        account: PrivateKey.random().publicKey().solanaKey(),
        currentAuthority: PrivateKey.random().publicKey().solanaKey(),
        authorityType: AuthorityType.AccountHolder
    }
    let instruction = TokenProgram.setAuthority(params, tokenProgram)
    expect(instruction.data).toHaveLength(3)
    expect(instruction.data[0]).toEqual(Command.SetAuthority)
    expect(instruction.data[1]).toEqual(AuthorityType.AccountHolder)
    expect(instruction.data[2]).toEqual(0)

    expect(instruction.keys).toHaveLength(2)
    expect(instruction.keys[0].pubkey.toBase58()).toBe(params.account.toBase58())
    expect(instruction.keys[0].isSigner).toBeFalsy()
    expect(instruction.keys[0].isWritable).toBeTruthy()
    expect(instruction.keys[1].pubkey.toBase58()).toBe(params.currentAuthority.toBase58())
    expect(instruction.keys[1].isSigner).toBeTruthy()
    expect(instruction.keys[1].isWritable).toBeFalsy()

    expect(params).toEqual(
        TokenInstruction.decodeSetAuthority(instruction, tokenProgram)
    )

    params = {
        account: PrivateKey.random().publicKey().solanaKey(),
        currentAuthority: PrivateKey.random().publicKey().solanaKey(),
        newAuthority: PrivateKey.random().publicKey().solanaKey(),
        authorityType: AuthorityType.CloseAccount,
    }
    instruction = TokenProgram.setAuthority(params, tokenProgram)
    expect(instruction.data).toHaveLength(35)
    expect(instruction.data[0]).toEqual(Command.SetAuthority)
    expect(instruction.data[1]).toEqual(AuthorityType.CloseAccount)
    expect(instruction.data[2]).toEqual(1)
    expect(instruction.data.slice(3)).toEqual(params.newAuthority!.toBuffer())

    expect(instruction.keys).toHaveLength(2)
    expect(instruction.keys[0].pubkey.toBase58()).toBe(params.account.toBase58())
    expect(instruction.keys[0].isSigner).toBeFalsy()
    expect(instruction.keys[0].isWritable).toBeTruthy()
    expect(instruction.keys[1].pubkey.toBase58()).toBe(params.currentAuthority.toBase58())
    expect(instruction.keys[1].isSigner).toBeTruthy()
    expect(instruction.keys[1].isWritable).toBeFalsy()

    expect(params).toEqual(
        TokenInstruction.decodeSetAuthority(instruction, tokenProgram)
    )
})
