import { ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AccountMeta, PublicKey as SolanaPublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';

// Reference: https://github.com/solana-labs/solana-program-library/blob/11b1e3eefdd4e523768d63f7c70a7aa391ea0d02/token/program/src/state.rs#L125
export const AccountSize = 165;


export enum Command {
    InitializeMint = 0,
    InitializeAccount = 1,
    InitializeMultisig = 2,
    Transfer = 3,
    Approve = 4,
    Revoke = 5,
    SetAuthority = 6,
    MintTo = 7,
    Burn = 8,
    CloseAccount = 9,
    FreezeAccount = 10,
    ThawAccount = 11,
    Transfer2 = 12,
    Approve2 = 13,
    MintTo2 = 14,
    Burn2 = 15,
}

export interface InitializeAccountParams {
    account: SolanaPublicKey,
    mint: SolanaPublicKey,
    owner: SolanaPublicKey
}

export interface TransferParams {
    source: SolanaPublicKey,
    dest: SolanaPublicKey,
    owner: SolanaPublicKey,
    amount: bigint,
}

export interface SetAuthorityParams {
    account: SolanaPublicKey,
    currentAuthority: SolanaPublicKey,
    newAuthority?: SolanaPublicKey,
    authorityType: AuthorityType,
}

export interface CreateAssociatedAccountParams {
    subsidizer: SolanaPublicKey
    address: SolanaPublicKey
    owner: SolanaPublicKey
    mint: SolanaPublicKey
}

export interface CloseAccountParams {
    account: SolanaPublicKey
    destination: SolanaPublicKey
    owner: SolanaPublicKey
}

// Use array index to map to the spl-token AuthorityType
export const AuthorityTypes: AuthorityType[] = [
    'MintTokens',
    'FreezeAccount',
    'AccountOwner',
    'CloseAccount',
];

export const AuthorityTypeToNumber: { [key in AuthorityType]: number; } = {
    'MintTokens': 0,
    'FreezeAccount': 1,
    'AccountOwner': 2,
    'CloseAccount': 3,
};

export class TokenInstruction {
    /**
     * Decode a initialize account token instruction and retrieve the instruction params.
     */
    static decodeInitializeAccount(instruction: TransactionInstruction): InitializeAccountParams {
        this.checkProgramId(instruction.programId, TOKEN_PROGRAM_ID);
        this.checkKeyLength(instruction.keys, 4);
        this.checkData(instruction.data, 1, Command.InitializeAccount);

        return {
            account: instruction.keys[0].pubkey,
            mint: instruction.keys[1].pubkey,
            owner: instruction.keys[2].pubkey,
        };
    }

    /**
     * Decode a transfer token instruction and retrieve the instruction params.
     */
    static decodeTransfer(instruction: TransactionInstruction): TransferParams {
        this.checkProgramId(instruction.programId, TOKEN_PROGRAM_ID);
        this.checkKeyLength(instruction.keys, 3);
        this.checkData(instruction.data, 9, Command.Transfer);

        return {
            source: instruction.keys[0].pubkey,
            dest: instruction.keys[1].pubkey,
            owner: instruction.keys[2].pubkey,
            amount: instruction.data.readBigUInt64LE(1)
        };
    }

    /**
     * Decode a set authority transfer 
     */
    static decodeSetAuthority(instruction: TransactionInstruction): SetAuthorityParams {
        this.checkProgramId(instruction.programId, TOKEN_PROGRAM_ID);
        this.checkKeyLength(instruction.keys, 2);
        
        if (instruction.data.length < 3) {
            throw new Error(`invalid instruction data size: ${instruction.data.length}`);
        }
        
        if (instruction.data[2] == 0) {
            this.checkData(instruction.data, 3, Command.SetAuthority);
        }
        if (instruction.data[2] == 1) {
            this.checkData(instruction.data, 35, Command.SetAuthority);
        }
        
        return {
            account: instruction.keys[0].pubkey,
            currentAuthority: instruction.keys[1].pubkey,
            authorityType: AuthorityTypes[instruction.data[1]],
            newAuthority: instruction.data[2] == 1 ? new SolanaPublicKey(instruction.data.slice(3)) : undefined
        };
    }
    
    static decodeCreateAssociatedAccount(instruction: TransactionInstruction): CreateAssociatedAccountParams {
        this.checkProgramId(instruction.programId, ASSOCIATED_TOKEN_PROGRAM_ID);
        this.checkKeyLength(instruction.keys, 7);
        
        if (instruction.data.length !== 0) {
            throw new Error(`invalid instruction data size: ${instruction.data.length}`);
        }
        if (!instruction.keys[4].pubkey.equals(SystemProgram.programId)) {
            throw new Error('system program key mismatch');
        }
        if (!instruction.keys[5].pubkey.equals(TOKEN_PROGRAM_ID)) {
            throw new Error('token progrma key mismatch');
        }
        if (!instruction.keys[6].pubkey.equals(SYSVAR_RENT_PUBKEY)) {
            throw new Error('rent sys var mismatch');
        }

        return {
            subsidizer: instruction.keys[0].pubkey,
            address: instruction.keys[1].pubkey,
            owner: instruction.keys[2].pubkey,
            mint: instruction.keys[3].pubkey,
        };
    }

    static decodeCloseAccount(instruction: TransactionInstruction): CloseAccountParams {
        this.checkProgramId(instruction.programId, TOKEN_PROGRAM_ID);
        this.checkData(instruction.data, 1, Command.CloseAccount);
        
        // note: we do < 3 instead of != 3 in order to support multisig cases
        if (instruction.keys.length < 3) {
            throw new Error(`invalid number of accounts: ${instruction.keys.length}`);
        }

        return {
            account: instruction.keys[0].pubkey,
            destination: instruction.keys[1].pubkey,
            owner: instruction.keys[2].pubkey,
        };
    }

    private static checkProgramId(programId: SolanaPublicKey, expectedProgramId: SolanaPublicKey) {
        if (!programId.equals(expectedProgramId)) {
            throw new Error('invalid instruction; programId is not expected program id');
        }
    }

    private static checkKeyLength(keys: AccountMeta[], expectedLength: number) {
        if (keys.length !== expectedLength) {
            throw new Error(`invalid instruction; found ${keys.length} keys, expected at least ${expectedLength}`);
        }
    }

    private static checkData(data: Buffer, expectedLength: number, expectedCommand: Command) {
        if (data.length < expectedLength) {
            throw new Error(`invalid instruction data size: ${data.length}`);
        }
        for (let i = expectedLength; i < data.length; i++) {
            if (data[i] != 0) {
                throw new Error(`invalid instruction data found at index ${i}`);
            }
        }

        if (data[0] !== expectedCommand) {
            throw new Error(`invalid instruction data: ${data}`);
        }
    }
}

export function getTokenCommand(instruction: TransactionInstruction): Command {
    if (!instruction.programId.equals(TOKEN_PROGRAM_ID)) {
        throw new Error('incorrect program');
    }
    if (instruction.data.length === 0) {
        throw new Error('token instruction missing data');
    }

    return instruction.data[0];
}
