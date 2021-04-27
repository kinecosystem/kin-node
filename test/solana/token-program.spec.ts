import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BigNumber from "bignumber.js";
import { bigNumberToU64 } from "../../src";
import { PrivateKey } from "../../src/keys";
import { InitializeAccountParams, SetAuthorityParams, TokenInstruction, TransferParams } from "../../src/solana/token-program";

test('TestTokenProgram_InitializeAccount', () => {
    const params: InitializeAccountParams = {
        account: PrivateKey.random().publicKey().solanaKey(),
        mint: PrivateKey.random().publicKey().solanaKey(),
        owner: PrivateKey.random().publicKey().solanaKey(),
    };
    const instruction = Token.createInitAccountInstruction(
        TOKEN_PROGRAM_ID,
        params.mint,
        params.account,
        params.owner,
    );

    expect(params).toEqual(TokenInstruction.decodeInitializeAccount(instruction));
});

test('TestTokenProgram_Transfer', () => {
    const params: TransferParams = {
        source: PrivateKey.random().publicKey().solanaKey(),
        dest: PrivateKey.random().publicKey().solanaKey(),
        owner: PrivateKey.random().publicKey().solanaKey(),
        amount: BigInt(123456789),
    };
    const instruction = Token.createTransferInstruction(
        TOKEN_PROGRAM_ID,
        params.source,
        params.dest,
        params.owner,
        [],
        bigNumberToU64(new BigNumber(123456789)),
    );

    expect(params).toEqual(TokenInstruction.decodeTransfer(instruction));
});


test('TestTokenProgram_SetAuthority', () => {
    let params: SetAuthorityParams = {
        account: PrivateKey.random().publicKey().solanaKey(),
        currentAuthority: PrivateKey.random().publicKey().solanaKey(),
        authorityType: 'AccountOwner',
    };
    let instruction = Token.createSetAuthorityInstruction(
        TOKEN_PROGRAM_ID,
        params.account,
        null,
        params.authorityType,
        params.currentAuthority,
        []
    );
    
    expect(params).toEqual(TokenInstruction.decodeSetAuthority(instruction));

    params = {
        account: PrivateKey.random().publicKey().solanaKey(),
        currentAuthority: PrivateKey.random().publicKey().solanaKey(),
        newAuthority: PrivateKey.random().publicKey().solanaKey(),
        authorityType: 'CloseAccount',
    };
    instruction = Token.createSetAuthorityInstruction(
        TOKEN_PROGRAM_ID,
        params.account,
        params.newAuthority!,
        params.authorityType,
        params.currentAuthority,
        [],
    );

    expect(params).toEqual(TokenInstruction.decodeSetAuthority(instruction));
});
