import accountgrpcv4 from "@kinecosystem/agora-api/node/account/v4/account_service_grpc_pb";
import accountpbv4 from "@kinecosystem/agora-api/node/account/v4/account_service_pb";
import airdropgrpcv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_grpc_pb";
import airdroppbv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import transactiongrpcv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_grpc_pb";
import transactionpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Account as SolanaAccount, Transaction as SolanaTransaction } from "@solana/web3.js";
import { BigNumber } from "bignumber.js";
import bs58 from "bs58";
import { promises as fs } from "fs";
import grpc from "grpc";
import { anything, instance, mock, reset, verify, when } from "ts-mockito";
import { v4 as uuidv4 } from 'uuid';
import {
    Commitment, InvoiceItem,
    invoiceToProto, PrivateKey,
    PublicKey,
    ReadOnlyPayment,
    TransactionState
} from "../../src";
import { InternalClient } from "../../src/client";
import { APP_INDEX_HEADER, KIN_VERSION_HEADER, USER_AGENT, USER_AGENT_HEADER } from "../../src/client/internal";
import { AccountDoesNotExist, AccountExists, AlreadySubmitted, BadNonce, InsufficientBalance, NoSubsidizerError, PayerRequired, TransactionRejected } from "../../src/errors";
import { TokenInstruction } from "../../src/solana/token-program";


const recentBlockhash = Buffer.alloc(32);
const minBalanceForRentExemption = 40175902;
const subsidizer = PrivateKey.random().publicKey().buffer;
const token = PrivateKey.random().publicKey().buffer;

function validateHeaders(md: grpc.Metadata): grpc.ServiceError | undefined {
    const mdMap = md.getMap();
    if (mdMap[USER_AGENT_HEADER] !== USER_AGENT) {
        return {
            name: "",
            message: "missing kin-user-agent",
            code: grpc.status.INVALID_ARGUMENT,
        };
    }

    if (mdMap[KIN_VERSION_HEADER] !== "4") {
        return {
            name: "",
            message: "incorrect kin_version",
            code: grpc.status.INVALID_ARGUMENT,
        };
    }

    if (mdMap[APP_INDEX_HEADER] && mdMap[APP_INDEX_HEADER] !== "1") {
        return {
            name: "",
            message: "incorrect app-index",
            code: grpc.status.INVALID_ARGUMENT,
        };
    }

    return undefined;
}

interface TestEnv {
    client: InternalClient
    accountClientV4: accountgrpcv4.AccountClient
    airdropClientV4: airdropgrpcv4.AirdropClient
    txClientV4: transactiongrpcv4.TransactionClient
}

function newTestEnv(appIndex?: number): TestEnv {
    const accountClientV4 = mock(accountgrpcv4.AccountClient);
    const airdropClientV4 = mock(airdropgrpcv4.AirdropClient);
    const txClientV4 = mock(transactiongrpcv4.TransactionClient);

    return {
        'client': new InternalClient({
            accountClientV4: instance(accountClientV4),
            airdropClientV4: instance(airdropClientV4),
            txClientV4: instance(txClientV4),
            appIndex: appIndex,
        }),
        'accountClientV4': accountClientV4,
        'airdropClientV4': airdropClientV4,
        'txClientV4': txClientV4,
    };
}

function setGetServiceConfigResp(txClientV4: transactiongrpcv4.TransactionClient) {
    when(txClientV4.getServiceConfig(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const subsidizerAccount = new commonpbv4.SolanaAccountId();
            subsidizerAccount.setValue(subsidizer);
            const tokenAccount = new commonpbv4.SolanaAccountId();
            tokenAccount.setValue(token);
            const tokenProgramAccount = new commonpbv4.SolanaAccountId();
            tokenProgramAccount.setValue(TOKEN_PROGRAM_ID.toBuffer());

            const resp = new transactionpbv4.GetServiceConfigResponse();
            resp.setSubsidizerAccount(subsidizerAccount);
            resp.setToken(tokenAccount);
            resp.setTokenProgram(tokenProgramAccount);

            const err = validateHeaders(md);
            if (err !== undefined) {
                callback(err, undefined);
                return;
            }

            callback(undefined, resp);
        });
}

function setGetServiceConfigRespNoSubsidizer(txClientV4: transactiongrpcv4.TransactionClient) {
    when(txClientV4.getServiceConfig(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const tokenAccount = new commonpbv4.SolanaAccountId();
            tokenAccount.setValue(token);
            const tokenProgramAccount = new commonpbv4.SolanaAccountId();
            tokenProgramAccount.setValue(TOKEN_PROGRAM_ID.toBuffer());

            const resp = new transactionpbv4.GetServiceConfigResponse();
            resp.setToken(tokenAccount);
            resp.setTokenProgram(tokenProgramAccount);

            const err = validateHeaders(md);
            if (err !== undefined) {
                callback(err, undefined);
                return;
            }

            callback(undefined, resp);
        });
}

function setGetRecentBlockhashResp(txClientV4: transactiongrpcv4.TransactionClient) {
    when(txClientV4.getRecentBlockhash(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const blockhash = new commonpbv4.Blockhash();
            blockhash.setValue(recentBlockhash);
            const resp = new transactionpbv4.GetRecentBlockhashResponse();
            resp.setBlockhash(blockhash);

            const err = validateHeaders(md);
            if (err !== undefined) {
                callback(err, undefined);
                return;
            }

            callback(undefined, resp);
        });
}

function setGetMinBalanceResp(txClientV4: transactiongrpcv4.TransactionClient) {
    when(txClientV4.getMinimumBalanceForRentExemption(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const resp = new transactionpbv4.GetMinimumBalanceForRentExemptionResponse();
            resp.setLamports(minBalanceForRentExemption);

            const err = validateHeaders(md);
            if (err !== undefined) {
                callback(err, undefined);
                return;
            }

            callback(undefined, resp);
        });
}

test('getBlockchainVersion', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];
    when(txClientV4.getMinimumKinVersion(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const resp = new transactionpbv4.GetMinimumKinVersionResponse();
            const err = validateHeaders(md);
            if (err !== undefined) {
                callback(err, undefined);
                return;
            }

            resp.setVersion(4);
            callback(undefined, resp);
        });
    expect(await client.getBlockchainVersion()).toBe(4);
});

test('createAccount', async () => {
    const account = PrivateKey.random();
    const tokenAccount = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, new PublicKey(token).solanaKey(), account.publicKey().solanaKey());

    const env = newTestEnv();
    const [client, accountClientV4, txClientV4] = [env.client, env.accountClientV4, env.txClientV4];

    setGetServiceConfigResp(txClientV4);
    setGetRecentBlockhashResp(txClientV4);

    let created = false;
    when(accountClientV4.createAccount(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.CreateAccountRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.CreateAccountResponse();
            if (created) {
                resp.setResult(accountpbv4.CreateAccountResponse.Result.EXISTS);
            } else {
                const tx = SolanaTransaction.from(req.getTransaction()!.getValue_asU8());
                expect(tx.signatures).toHaveLength(2);
                expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
                expect(tx.signatures[0].signature).toBeNull();

                expect(tx.signatures[1].publicKey.toBuffer()).toEqual(account.publicKey().buffer);
                expect(account.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

                expect(tx.instructions).toHaveLength(2);

                const createAssocInstruction = TokenInstruction.decodeCreateAssociatedAccount(tx.instructions[0]);
                expect(createAssocInstruction.subsidizer.toBuffer()).toEqual(subsidizer);
                expect(createAssocInstruction.address).toEqual(tokenAccount);
                expect(createAssocInstruction.owner.toBuffer()).toEqual(account.publicKey().buffer);
                expect(createAssocInstruction.mint.toBuffer()).toEqual(token);

                const setAuthInstruction = TokenInstruction.decodeSetAuthority(tx.instructions[1]);
                expect(setAuthInstruction.account).toEqual(tokenAccount);
                expect(setAuthInstruction.currentAuthority.toBuffer()).toEqual(account.publicKey().buffer);
                expect(setAuthInstruction.newAuthority!.toBuffer()).toEqual(subsidizer);
                expect(setAuthInstruction.authorityType).toEqual('CloseAccount');

                resp.setResult(accountpbv4.CreateAccountResponse.Result.OK);
                created = true;
            }
            callback(undefined, resp);
        });

    await client.createAccount(account);
    expect(created).toBeTruthy();

    try {
        await client.createAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountExists);
    }
});
test('createAccount no service subsidizer', async () => {
    const account = PrivateKey.random();
    const tokenAccount = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, new PublicKey(token).solanaKey(), account.publicKey().solanaKey());

    const appSubsidizer = PrivateKey.random();
    const env = newTestEnv();
    const [client, accountClientV4, txClientV4] = [env.client, env.accountClientV4, env.txClientV4];

    setGetServiceConfigRespNoSubsidizer(txClientV4);
    setGetRecentBlockhashResp(txClientV4);

    when(accountClientV4.createAccount(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.CreateAccountRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.CreateAccountResponse();

            // This should only be reached if an app subsidizer was passed in
            const tx = SolanaTransaction.from(req.getTransaction()!.getValue_asU8());
            expect(tx.signatures).toHaveLength(2);
            expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
            expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();

            expect(tx.signatures[1].publicKey.toBuffer()).toEqual(account.publicKey().buffer);
            expect(account.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

            expect(tx.instructions).toHaveLength(2);

            const createAssocInstruction = TokenInstruction.decodeCreateAssociatedAccount(tx.instructions[0]);
            expect(createAssocInstruction.subsidizer.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
            expect(createAssocInstruction.address).toEqual(tokenAccount);
            expect(createAssocInstruction.owner.toBuffer()).toEqual(account.publicKey().buffer);
            expect(createAssocInstruction.mint.toBuffer()).toEqual(token);

            const setAuthInstruction = TokenInstruction.decodeSetAuthority(tx.instructions[1]);
            expect(setAuthInstruction.account).toEqual(tokenAccount);
            expect(setAuthInstruction.currentAuthority.toBuffer()).toEqual(account.publicKey().buffer);
            expect(setAuthInstruction.newAuthority!.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
            expect(setAuthInstruction.authorityType).toEqual('CloseAccount');

            resp.setResult(accountpbv4.CreateAccountResponse.Result.OK);
            callback(undefined, resp);
        });

    // Don't pass in subsidizer
    try {
        await client.createAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(NoSubsidizerError);
    }

    // Pass in subsidizer
    await client.createAccount(account, undefined, appSubsidizer);
});
test('createAccount errors', async () => {
    const testCases = [
        {
            result: accountpbv4.CreateAccountResponse.Result.EXISTS,
            error: AccountExists,
        },
        {
            result: accountpbv4.CreateAccountResponse.Result.PAYER_REQUIRED,
            error: PayerRequired,
        },
        {
            result: accountpbv4.CreateAccountResponse.Result.BAD_NONCE,
            error: BadNonce,
        },
    ];

    const account = PrivateKey.random();
    const env = newTestEnv();
    const [client, accountClientV4, txClientV4] = [env.client, env.accountClientV4, env.txClientV4];

    setGetServiceConfigResp(txClientV4);
    setGetRecentBlockhashResp(txClientV4);

    let currentCase = 0;
    when(accountClientV4.createAccount(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.CreateAccountResponse();
            resp.setResult(testCases[currentCase].result);
            callback(undefined, resp);
        });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        try {
            await client.createAccount(account);
            fail();
        } catch (err) {
            expect(err).toBeInstanceOf(tc.error);
        }
    }
});

test('getAccountInfo', async() => {
    const account1 = PrivateKey.random().publicKey();
    const account2 = PrivateKey.random().publicKey();
    const env = newTestEnv();
    const [client, accountClientV4] = [env.client, env.accountClientV4];

    when(accountClientV4.getAccountInfo(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.GetAccountInfoRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.GetAccountInfoResponse();
            if (req.getAccountId()!.getValue_asU8() === account1.buffer) {
                const accountID = new commonpbv4.SolanaAccountId();
                accountID.setValue(account1.buffer);

                const info = new accountpbv4.AccountInfo();
                info.setAccountId(accountID);
                info.setBalance("100");

                resp.setResult(accountpbv4.GetAccountInfoResponse.Result.OK);
                resp.setAccountInfo(info);
            } else {
                resp.setResult(accountpbv4.GetAccountInfoResponse.Result.NOT_FOUND);
            }
            callback(undefined, resp);
        });

    const info = await client.getAccountInfo(account1);
    expect(info.getAccountId()!.getValue_asU8()).toEqual(account1.buffer);
    expect(info.getBalance()).toEqual("100");

    try {
        await client.getAccountInfo(account2);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountDoesNotExist);
    }
});

test('resolveTokenAccounts', async() => {
    const env = newTestEnv();
    const [client, accountClientV4] = [env.client, env.accountClientV4];

    const tokenAccounts = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const [account, subsidizer] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];
    const ownerAccountId = new commonpbv4.SolanaAccountId();
    ownerAccountId.setValue(account.buffer);
    const subsidizerId = new commonpbv4.SolanaAccountId();
    subsidizerId.setValue(subsidizer.buffer);

    let requestedNoInfo = false;
    let requestedWithInfo = false;

    // On first request of each type, do not include account info.
    when (accountClientV4.resolveTokenAccounts(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.ResolveTokenAccountsRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.ResolveTokenAccountsResponse();
            if (Buffer.from(req.getAccountId()!.getValue_asU8()).equals(account.buffer)) {
                const ids: commonpbv4.SolanaAccountId[] = [];
                tokenAccounts.forEach(tokenAccount => {
                    const accountId = new commonpbv4.SolanaAccountId();
                    accountId.setValue(tokenAccount.buffer);
                    ids.push(accountId);
                });
                resp.setTokenAccountsList(ids);

                let setAccountInfos = false;
                if (req.getIncludeAccountInfo()) {
                    if (requestedWithInfo) {
                        setAccountInfos = true;
                    }

                    requestedWithInfo = true;
                } else {
                    if (requestedNoInfo) {
                        setAccountInfos = true;
                    }
                    requestedNoInfo = true;
                }

                if (setAccountInfos) {
                    const infos: accountpbv4.AccountInfo[] = [];
                    tokenAccounts.forEach((_, i) => {
                        const accountInfo = new accountpbv4.AccountInfo();
                        accountInfo.setAccountId(resp.getTokenAccountsList()[i]);
                        if (req.getIncludeAccountInfo()) {
                            accountInfo.setBalance("10");
                            accountInfo.setOwner(ownerAccountId);
                            accountInfo.setCloseAuthority(subsidizerId);
                        }
                        infos.push(accountInfo);
                    });
                    resp.setTokenAccountInfosList(infos);
                }
            }
            callback(undefined, resp);
        });

    // Account info not requested, only IDs available
    let accountInfos = await client.resolveTokenAccounts(account);
    expect(accountInfos.length).toEqual(tokenAccounts.length);
    for (let i = 0; i < tokenAccounts.length; i++) {
        expect(accountInfos[i].getAccountId()!.getValue_asU8()).toEqual(tokenAccounts[i].buffer);
        expect(accountInfos[i].getBalance()).toEqual("0");
        expect(accountInfos[i].getOwner()).toBeUndefined();
        expect(accountInfos[i].getCloseAuthority()).toBeUndefined();
    }

    // Account info not requested, info available
    accountInfos = await client.resolveTokenAccounts(account);
    expect(accountInfos.length).toEqual(tokenAccounts.length);
    for (let i = 0; i < tokenAccounts.length; i++) {
        expect(accountInfos[i].getAccountId()!.getValue_asU8()).toEqual(tokenAccounts[i].buffer);
        expect(accountInfos[i].getBalance()).toEqual("0");
        expect(accountInfos[i].getOwner()).toBeUndefined();
        expect(accountInfos[i].getCloseAuthority()).toBeUndefined();
    }

    // Account info requested, only IDs available
    try {
        await client.resolveTokenAccounts(account, true);
    } catch (error) {
        expect(error.toString()).toContain("server does not support resolving with account info");
    }

    // Account info requested, info available
    accountInfos = await client.resolveTokenAccounts(account, true);
    for (let i = 0; i < tokenAccounts.length; i++) {
        expect(accountInfos[i].getAccountId()!.getValue_asU8()).toEqual(tokenAccounts[i].buffer);
        expect(accountInfos[i].getBalance()).toEqual("10");
        expect(accountInfos[i].getOwner()!.getValue()).toEqual(account.buffer);
        expect(accountInfos[i].getCloseAuthority()!.getValue_asU8()).toEqual(subsidizer.buffer);
    }

    // No token accounts
    expect(await client.resolveTokenAccounts(tokenAccounts[0])).toHaveLength(0);
});

test('getTransaction Kin 3', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];

    const testCases: {
        transaction_data: {
            tx_id: string
            payments: {
                sender: string
                destination: string
                type: number
                quarks: number
                memo?: string
                invoice: {
                    items: {
                        title: string
                        description?: string
                        amount: string
                        sku?: string
                    }[]
                }
            }[],
        },
        transaction_state: number,
        response: string
    }[] = JSON.parse((await fs.readFile("test/data/get_transaction_test_kin_3.json")).toString());

    let currentCase = 0;
    when(txClientV4.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = transactionpbv4.GetTransactionResponse
                .deserializeBinary(Buffer.from(testCases[currentCase].response, "base64"));
            callback(undefined, resp);
        });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        const txData = await client.getTransaction(Buffer.from(tc.transaction_data.tx_id, "base64"));
        expect(txData).toBeDefined();
        expect(txData!.txState).toBe(tc.transaction_state);
        expect(txData!.errors).toBeUndefined();
        expect(txData!.txId).toStrictEqual(Buffer.from(tc.transaction_data.tx_id, "base64"));

        const expectedPayments = testCases[currentCase].transaction_data.payments.map(p => {
            const payment: ReadOnlyPayment = {
                sender: new PublicKey(Buffer.from(p.sender, "base64")),
                destination: new PublicKey(Buffer.from(p.destination, "base64")),
                type: p.type,
                quarks: new BigNumber(p.quarks).toString(),
            };
            if (p.memo) {
                payment.memo = p.memo;
            }
            if (p.invoice) {
                payment.invoice = {
                    Items: p.invoice.items.map(item => {
                        const invoiceItem: InvoiceItem = {
                            title: item.title,
                            amount: new BigNumber(item.amount),
                        };
                        if (item.description) {
                            invoiceItem.description = item.description;
                        }
                        if (item.sku) {
                            invoiceItem.sku = Buffer.from(item.sku, "base64");
                        }
                        return invoiceItem;
                    })
                };
            }
            return payment;
        });
        expect(txData!.payments).toStrictEqual(expectedPayments);
    }
});

test('getTransaction Kin 2', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];

    const testCases: {
        transaction_data: {
            tx_id: string
            payments: {
                sender: string
                destination: string
                type: number
                quarks: number
                memo?: string
                invoice: {
                    items: {
                        title: string
                        description?: string
                        amount: string
                        sku?: string
                    }[]
                }
            }[],
        },
        transaction_state: number,
        response: string
    }[] = JSON.parse((await fs.readFile("test/data/get_transaction_test_kin_2.json")).toString());

    let currentCase = 0;
    when(txClientV4.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = transactionpbv4.GetTransactionResponse
                .deserializeBinary(Buffer.from(testCases[currentCase].response, "base64"));
            callback(undefined, resp);
        });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        const txData = await client.getTransaction(Buffer.from(tc.transaction_data.tx_id, "base64"));
        expect(txData).toBeDefined();
        expect(txData!.txState).toBe(tc.transaction_state);
        expect(txData!.errors).toBeUndefined();
        expect(txData!.txId).toStrictEqual(Buffer.from(tc.transaction_data.tx_id, "base64"));

        const expectedPayments = testCases[currentCase].transaction_data.payments.map(p => {
            const payment: ReadOnlyPayment = {
                sender: new PublicKey(Buffer.from(p.sender, "base64")),
                destination: new PublicKey(Buffer.from(p.destination, "base64")),
                type: p.type,
                quarks: new BigNumber(p.quarks).toString(),
            };
            if (p.memo) {
                payment.memo = p.memo;
            }
            if (p.invoice) {
                payment.invoice = {
                    Items: p.invoice.items.map(item => {
                        const invoiceItem: InvoiceItem = {
                            title: item.title,
                            amount: new BigNumber(item.amount),
                        };
                        if (item.description) {
                            invoiceItem.description = item.description;
                        }
                        if (item.sku) {
                            invoiceItem.sku = Buffer.from(item.sku, "base64");
                        }
                        return invoiceItem;
                    })
                };
            }
            return payment;
        });
        expect(txData!.payments).toStrictEqual(expectedPayments);
    }
});
test('getTransaction Kin 4', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];

    const testCases: {
        transaction_data: {
            tx_id: string
            payments: {
                sender: string
                destination: string
                type: number
                quarks: number
                memo?: string
                invoice: {
                    items: {
                        title: string
                        description?: string
                        amount: string
                        sku?: string
                    }[]
                }
            }[],
        },
        transaction_state: number,
        response: string
    }[] = JSON.parse((await fs.readFile("test/data/get_transaction_test_kin_4.json")).toString());

    let currentCase = 0;
    when(txClientV4.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = transactionpbv4.GetTransactionResponse
                .deserializeBinary(Buffer.from(testCases[currentCase].response, "base64"));
            callback(undefined, resp);
        });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        const txData = await client.getTransaction(Buffer.from(tc.transaction_data.tx_id, "base64"));
        expect(txData).toBeDefined();
        expect(txData!.txState).toBe(tc.transaction_state);
        expect(txData!.errors).toBeUndefined();
        expect(txData!.txId).toStrictEqual(Buffer.from(tc.transaction_data.tx_id, "base64"));

        const expectedPayments = testCases[currentCase].transaction_data.payments.map(p => {
            const payment: ReadOnlyPayment = {
                sender: new PublicKey(Buffer.from(p.sender, "base64")),
                destination: new PublicKey(Buffer.from(p.destination, "base64")),
                type: p.type,
                quarks: new BigNumber(p.quarks).toString(),
            };
            if (p.memo) {
                payment.memo = p.memo;
            }
            if (p.invoice) {
                payment.invoice = {
                    Items: p.invoice.items.map(item => {
                        const invoiceItem: InvoiceItem = {
                            title: item.title,
                            amount: new BigNumber(item.amount),
                        };
                        if (item.description) {
                            invoiceItem.description = item.description;
                        }
                        if (item.sku) {
                            invoiceItem.sku = Buffer.from(item.sku, "base64");
                        }
                        return invoiceItem;
                    })
                };
            }
            return payment;
        });
        expect(txData!.payments).toStrictEqual(expectedPayments);
    }
});
test('getTransaction Kin 4 failed', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];

    when(txClientV4.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new transactionpbv4.GetTransactionResponse();
            resp.setState(transactionpbv4.GetTransactionResponse.State.FAILED);

            callback(undefined, resp);
        });

    const txData = await client.getTransaction(Buffer.from("someid"));
    expect(txData).toBeDefined();
    expect(txData!.txState).toBe(TransactionState.Failed);
    expect(txData!.errors).toBeUndefined();
    expect(txData!.payments).toHaveLength(0);
});

test('signTransaction', async() => {
    const env = newTestEnv();
    const subsidizer = PrivateKey.random();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const tx = new SolanaTransaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    let invoiceList: commonpb.InvoiceList | undefined = undefined;
    let submitted: transactionpbv4.SignTransactionRequest | undefined;
    let sig: Buffer | undefined;
    when(txClientV4.signTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpbv4.SignTransactionRequest, md: grpc.Metadata, callback) => {
            submitted = req;
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            // Validate request
            expect(Buffer.from(req.getTransaction()!.getValue_asU8())).toStrictEqual(tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            }));
            expect(req.getInvoiceList()).toBe(invoiceList);

            const parsedTx = SolanaTransaction.from(req.getTransaction()!.getValue_asU8());
            parsedTx.sign(new SolanaAccount(subsidizer.secretKey()));

            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(parsedTx.signature!);
            sig = parsedTx.signature!;

            const resp = new transactionpbv4.SignTransactionResponse();
            resp.setResult(transactionpbv4.SignTransactionResponse.Result.OK);
            resp.setSignature(txSig);

            callback(undefined, resp);
        });

    let result = await client.signTransaction(tx);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();

    invoiceList = new commonpb.InvoiceList();
    invoiceList.addInvoices(invoiceToProto({
        Items: [
            {
                title: "hello",
                description: "world",
                amount: new BigNumber(10),
            },
        ]
    }));

    // Include invoice list
    result = await client.signTransaction(tx, invoiceList);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
});
test('signTransaction rejected', async() => {
    const env = newTestEnv();
    const subsidizer = PrivateKey.random();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const tx = new SolanaTransaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    when(txClientV4.signTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpbv4.SignTransactionRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            expect(Buffer.from(req.getTransaction()!.getValue_asU8())).toStrictEqual(tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            }));

            const resp = new transactionpbv4.SignTransactionResponse();
            resp.setResult(transactionpbv4.SignTransactionResponse.Result.REJECTED);

            callback(undefined, resp);
        });

    try {
        await client.signTransaction(tx);
    } catch (err) {
        expect(err).toBeInstanceOf(TransactionRejected);
    }
});
test('signTransaction invoice errors', async() => {
    const env = newTestEnv();
    const subsidizer = PrivateKey.random();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const tx = new SolanaTransaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    const invoices = [
        invoiceToProto({
            Items: [
                {
                    title: "1",
                    description: "2",
                    amount: new BigNumber(10),
                },
            ]
        }),
        invoiceToProto({
            Items: [
                {
                    title: "3",
                    description: "4",
                    amount: new BigNumber(10),
                },
            ]
        }),
        invoiceToProto({
            Items: [
                {
                    title: "5",
                    description: "6",
                    amount: new BigNumber(10),
                },
            ]
        }),
    ];

    when(txClientV4.signTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpbv4.SignTransactionRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            expect(Buffer.from(req.getTransaction()!.getValue_asU8())).toStrictEqual(tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            }));

            const invoiceErrors = new Array<commonpb.InvoiceError>(3);
            for (let i = 0; i < invoices.length; i++) {
                invoiceErrors[i] = new commonpb.InvoiceError();
                invoiceErrors[i].setOpIndex(i);
                invoiceErrors[i].setReason(i + 1);
                invoiceErrors[i].setInvoice(invoices[i]);
            }

            const resp = new transactionpbv4.SignTransactionResponse();
            resp.setResult(transactionpbv4.SignTransactionResponse.Result.INVOICE_ERROR);
            resp.setInvoiceErrorsList(invoiceErrors);

            callback(undefined, resp);
        });

    const result = await client.signTransaction(tx);
    expect(result.InvoiceErrors).toHaveLength(3);
    result.InvoiceErrors?.forEach((err, i) => {
        expect(err.getOpIndex()).toBe(i);
        expect(err.getReason()).toBe((i + 1) as commonpb.InvoiceError.Reason);
        expect(err.getInvoice()).toBe(invoices[i]);
    });
});

test('submitTransaction', async () => {
    const env = newTestEnv();
    const subsidizer = PrivateKey.random();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const tx = new SolanaTransaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );
    tx.sign(new SolanaAccount(subsidizer.secretKey()));
    const sig = tx.signature!;

    let invoiceList: commonpb.InvoiceList | undefined = undefined;
    let commitment: commonpbv4.Commitment = commonpbv4.Commitment.SINGLE;
    let expectedDedupeId: Buffer | undefined = undefined;

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpbv4.SubmitTransactionRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            // Validate request
            expect(Buffer.from(req.getTransaction()!.getValue_asU8())).toStrictEqual(tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            }));
            expect(req.getInvoiceList()).toBe(invoiceList);
            if (expectedDedupeId) {
                expect(Buffer.from(req.getDedupeId())).toEqual(expectedDedupeId);
            } else {
                expect(req.getDedupeId()).toEqual("");
            }
            expect(req.getCommitment()).toEqual(commitment);

            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(sig);

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.OK);
            resp.setSignature(txSig);

            callback(undefined, resp);
        });

    let result = await client.submitTransaction(tx);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
    expect(result.Errors).toBeUndefined();

    invoiceList = new commonpb.InvoiceList();
    invoiceList.addInvoices(invoiceToProto({
        Items: [
            {
                title: "hello",
                description: "world",
                amount: new BigNumber(10),
            },
        ]
    }));

    result = await client.submitTransaction(tx, invoiceList);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
    expect(result.Errors).toBeUndefined();

    // Submit with all options
    expectedDedupeId = Buffer.from(uuidv4());
    commitment = commonpbv4.Commitment.MAX;
    result = await client.submitTransaction(tx, invoiceList, Commitment.Max, expectedDedupeId);

    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
    expect(result.Errors).toBeUndefined();
});
test('submitTransaction already submitted', async () => {
    const env = newTestEnv();
    const subsidizer = PrivateKey.random();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const tx = new SolanaTransaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );
    tx.sign(new SolanaAccount(subsidizer.secretKey()));
    const sig = tx.signature!;

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpbv4.SubmitTransactionRequest, md: grpc.Metadata, callback) => {
            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(sig);

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.ALREADY_SUBMITTED);
            resp.setSignature(txSig);

            callback(undefined, resp);
        });

    try {
        await client.submitTransaction(tx);
        fail();
    } catch (error) {
        expect(error).toBeInstanceOf(AlreadySubmitted);
    }

    reset(txClientV4);

    let attempt = 0;
    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpbv4.SubmitTransactionRequest, md: grpc.Metadata, callback) => {
            attempt = attempt + 1;

            if (attempt == 1) {
                const err: grpc.ServiceError = {
                    name: "",
                    message: "",
                    code: grpc.status.INTERNAL,
                };
                callback(err, new transactionpbv4.SubmitTransactionResponse());
                return;
            } else {
                const txSig = new commonpbv4.TransactionSignature();
                txSig.setValue(sig);

                const resp = new transactionpbv4.SubmitTransactionResponse();
                resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.ALREADY_SUBMITTED);
                resp.setSignature(txSig);

                callback(undefined, resp);
            }
        });

    const result = await client.submitTransaction(tx);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
    expect(result.Errors).toBeUndefined();
});
test('submitTransaction failed', async () => {
    const env = newTestEnv();
    const subsidizer = PrivateKey.random();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const tx = new SolanaTransaction({
        feePayer: subsidizer.publicKey().solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );
    tx.sign(new SolanaAccount(subsidizer.secretKey()));
    const sig = tx.signature!;

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(sig);

            const txError = new commonpbv4.TransactionError();
            txError.setReason(commonpbv4.TransactionError.Reason.BAD_NONCE);

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setSignature(txSig);
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.FAILED);
            resp.setTransactionError(txError);

            callback(undefined, resp);
        });

    const resp = await client.submitTransaction(tx);
    expect(resp.TxId).toStrictEqual(sig);
    expect(resp.InvoiceErrors).toBeUndefined();
    expect(resp.Errors?.OpErrors![0]).toBeInstanceOf(BadNonce);
});
test('submitTransaction rejected', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const transaction = new SolanaTransaction({
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.REJECTED);

            callback(undefined, resp);
        });

    try {
        await client.submitTransaction(transaction);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(TransactionRejected);
    }
});
test('submitTransaction payer required', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const transaction = new SolanaTransaction({
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.PAYER_REQUIRED);

            callback(undefined, resp);
        });

    try {
        await client.submitTransaction(transaction);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(PayerRequired);
    }
});
test('submitTransaction invoice error', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const transaction = new SolanaTransaction({
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            sender.solanaKey(),
            destination.solanaKey(),
            sender.solanaKey(),
            [],
            100,
        )
    );

    const invoices = [
        invoiceToProto({
            Items: [
                {
                    title: "1",
                    description: "2",
                    amount: new BigNumber(10),
                },
            ]
        }),
        invoiceToProto({
            Items: [
                {
                    title: "3",
                    description: "4",
                    amount: new BigNumber(10),
                },
            ]
        }),
        invoiceToProto({
            Items: [
                {
                    title: "5",
                    description: "6",
                    amount: new BigNumber(10),
                },
            ]
        }),
    ];

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const invoiceErrors = new Array<commonpb.InvoiceError>(3);
            for (let i = 0; i < 3; i++) {
                invoiceErrors[i] = new commonpb.InvoiceError();
                invoiceErrors[i].setOpIndex(i);
                invoiceErrors[i].setReason(i + 1);
                invoiceErrors[i].setInvoice(invoices[i]);
            }

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.INVOICE_ERROR);
            resp.setInvoiceErrorsList(invoiceErrors);

            callback(undefined, resp);
        });

    const resp = await client.submitTransaction(transaction);
    expect(resp.Errors).toBeUndefined();
    expect(resp.InvoiceErrors).toHaveLength(3);
    resp.InvoiceErrors?.forEach((err, i) => {
        expect(err.getOpIndex()).toBe(i);
        expect(err.getReason()).toBe((i + 1) as commonpb.InvoiceError.Reason);
        expect(err.getInvoice()).toBe(invoices[i]);
    });
});

test('getServiceConfig', async () => {
    const env = newTestEnv(1);
    const [client, txClientV4] = [env.client, env.txClientV4];

    setGetServiceConfigResp(txClientV4);

    const resp = await client.getServiceConfig();
    expect(Buffer.from(resp.getSubsidizerAccount()!.getValue_asU8())).toEqual(subsidizer);
    expect(Buffer.from(resp.getToken()!.getValue_asU8())).toEqual(token);
    expect(Buffer.from(resp.getTokenProgram()!.getValue_asU8())).toEqual(TOKEN_PROGRAM_ID.toBuffer());

    await client.getServiceConfig();

    // Verify that only one request was submitted
    verify(txClientV4.getServiceConfig(anything(), anything(), anything())).times(1);
});

test('getRecentBlockhash', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];

    setGetRecentBlockhashResp(txClientV4);

    const result = await client.getRecentBlockhash();
    expect(result).toEqual(bs58.encode(recentBlockhash));
});

test('getMinimumBalanceForRentExemption', async () => {
    const env = newTestEnv();
    const [client, txClientV4] = [env.client, env.txClientV4];

    setGetMinBalanceResp(txClientV4);

    const result = await client.getMinimumBalanceForRentExemption();
    expect(result).toEqual(minBalanceForRentExemption);
});

test('requestAirdrop', async() => {
    const env = newTestEnv();
    const [client, airdropClientV4] = [env.client, env.airdropClientV4];

    const [account1, account2] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];
    const txSig = Buffer.from("sometxsig");

    when(airdropClientV4.requestAirdrop(anything(), anything(), anything()))
        .thenCall((req: airdroppbv4.RequestAirdropRequest, md, callback) => {
            const err = validateHeaders(md);
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new airdroppbv4.RequestAirdropResponse();
            if (req.getQuarks() > 10) {
                resp.setResult(airdroppbv4.RequestAirdropResponse.Result.INSUFFICIENT_KIN);
            } else if (Buffer.from(req.getAccountId()!.getValue_asU8()).equals(account1.buffer)) {
                const sig = new commonpbv4.TransactionSignature();
                sig.setValue(txSig);

                resp.setResult(airdroppbv4.RequestAirdropResponse.Result.OK);
                resp.setSignature(sig);
            } else {
                resp.setResult(airdroppbv4.RequestAirdropResponse.Result.NOT_FOUND);
            }
            callback(undefined, resp);
        });

    const airdropSig = await client.requestAirdrop(account1, new BigNumber(10));
    expect(airdropSig).toEqual(txSig);

    try {
        await client.requestAirdrop(account1, new BigNumber(11));
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(InsufficientBalance);
    }

    try {
        await client.requestAirdrop(account2, new BigNumber(9));
    } catch (err) {
        expect(err).toBeInstanceOf(AccountDoesNotExist);
    }
});

test('internal retry Kin 4', async () => {
    let env = newTestEnv();
    const [accountClientV4, airdropClientV4] = [env.accountClientV4, env.airdropClientV4];
    let [client, txClientV4] = [env.client, env.txClientV4];

    const account = PrivateKey.random();
    when(accountClientV4.createAccount(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new accountpbv4.CreateAccountRequest());
        });
    when(accountClientV4.getAccountInfo(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new accountpbv4.GetAccountInfoResponse());
        });
    when(airdropClientV4.requestAirdrop(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new airdroppbv4.RequestAirdropResponse());
        });
    when(txClientV4.getTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new transactionpbv4.GetTransactionResponse());
        });
    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new transactionpbv4.SubmitTransactionResponse());
        });

    setGetServiceConfigResp(txClientV4);
    setGetMinBalanceResp(txClientV4);
    setGetRecentBlockhashResp(txClientV4);

    try {
        await client.createAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(accountClientV4.createAccount(anything(), anything(), anything())).times(3);

    try {
        await client.getAccountInfo(new PublicKey(Buffer.alloc(32)));
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(accountClientV4.createAccount(anything(), anything(), anything())).times(3);

    try {
        await client.getTransaction(Buffer.alloc(32));
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClientV4.getTransaction(anything(), anything(), anything())).times(3);

    const transaction = new SolanaTransaction({
        feePayer: PrivateKey.random().publicKey().solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        Token.createTransferInstruction(
            TOKEN_PROGRAM_ID,
            PrivateKey.random().publicKey().solanaKey(),
            PrivateKey.random().publicKey().solanaKey(),
            PrivateKey.random().publicKey().solanaKey(),
            [],
            100,
        )
    );
    try {
        await client.submitTransaction(transaction);
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClientV4.submitTransaction(anything(), anything(), anything())).times(3);

    try {
        await client.requestAirdrop(account.publicKey(), new BigNumber(10));
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(airdropClientV4.requestAirdrop(anything(), anything(), anything())).times(3);

    env = newTestEnv();
    client = env.client;
    txClientV4 = env.txClientV4;

    when(txClientV4.getServiceConfig(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new transactionpbv4.SubmitTransactionResponse());
        });

    when(txClientV4.getRecentBlockhash(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new transactionpbv4.GetRecentBlockhashResponse());
        });

    when(txClientV4.getMinimumBalanceForRentExemption(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new transactionpbv4.GetMinimumBalanceForRentExemptionResponse());
        });

    try {
        await client.getServiceConfig();
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClientV4.getServiceConfig(anything(), anything(), anything())).times(3);

    try {
        await client.getRecentBlockhash();
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClientV4.getRecentBlockhash(anything(), anything(), anything())).times(3);

    try {
        await client.getMinimumBalanceForRentExemption();
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClientV4.getMinimumBalanceForRentExemption(anything(), anything(), anything())).times(3);
});
