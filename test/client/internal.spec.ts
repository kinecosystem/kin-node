import grpc from "grpc";
import { promises as fs } from "fs";
import { BigNumber } from "bignumber.js";
import { mock, when, anything, instance, verify, reset } from "ts-mockito";
import { PublicKey as SolanaPublicKey, SystemInstruction, Transaction as SolanaTransaction } from "@solana/web3.js"; 
import { v4 as uuidv4 } from 'uuid';
import bs58 from "bs58";

import accountpb from "@kinecosystem/agora-api/node/account/v3/account_service_pb";
import accountpbv4 from "@kinecosystem/agora-api/node/account/v4/account_service_pb";
import accountgrpc from "@kinecosystem/agora-api/node/account/v3/account_service_grpc_pb";
import accountgrpcv4 from "@kinecosystem/agora-api/node/account/v4/account_service_grpc_pb";
import airdropgrpcv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_grpc_pb";
import airdroppbv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import transactionpb from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_pb";
import transactionpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import transactiongrpc from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_grpc_pb";
import transactiongrpcv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_grpc_pb";

import { InternalClient } from "../../src/client";
import { USER_AGENT_HEADER, USER_AGENT, KIN_VERSION_HEADER, InternalClientConfig, DESIRED_KIN_VERSION_HEADER } from "../../src/client/internal";
import { xdr } from "stellar-base";
import { AccountDoesNotExist, AccountExists, AlreadySubmitted, BadNonce, InsufficientBalance, InvalidSignature, NoSubsidizerError, PayerRequired, TransactionRejected } from "../../src/errors";
import {
    PrivateKey,
    PublicKey,
    ReadOnlyPayment,
    InvoiceItem,
    invoiceToProto,
    TransactionState,
    Commitment,
} from "../../src";
import { AccountSize, AuthorityType, TokenInstruction, TokenProgram } from "../../src/solana/token-program";
import { generateTokenAccount } from "../../src/client/utils";

const recentBlockhash = Buffer.alloc(32);
const minBalanceForRentExemption = 40175902;
const subsidizer = PrivateKey.random().publicKey().buffer;
const token = PrivateKey.random().publicKey().buffer;
const tokenProgram = PrivateKey.random().publicKey().buffer;

function validateHeaders(md: grpc.Metadata, expectedVersion: string): grpc.ServiceError | undefined {
    const mdMap = md.getMap();
    if (mdMap[USER_AGENT_HEADER] !== USER_AGENT) {
        return {
            name: "",
            message: "missing kin-user-agent",
            code: grpc.status.INVALID_ARGUMENT,
        };
    }

    if (mdMap[KIN_VERSION_HEADER] !== expectedVersion) {
        return {
            name: "",
            message: "incorrect kin_version",
            code: grpc.status.INVALID_ARGUMENT,
        };
    }

    return undefined;
}

interface TestEnv {
    client: InternalClient
    accountClient: accountgrpc.AccountClient
    txClient: transactiongrpc.TransactionClient
    accountClientV4: accountgrpcv4.AccountClient
    airdropClientV4: airdropgrpcv4.AirdropClient
    txClientV4: transactiongrpcv4.TransactionClient
}

function newTestEnv(kinVersion: number, desiredKinVersion?: number): TestEnv {
    const accountClient = mock(accountgrpc.AccountClient);
    const txClient = mock(transactiongrpc.TransactionClient);
    const accountClientV4 = mock(accountgrpcv4.AccountClient);
    const airdropClientV4 = mock(airdropgrpcv4.AirdropClient);
    const txClientV4 = mock(transactiongrpcv4.TransactionClient);

    return {
        'client': new InternalClient({
            accountClient: instance(accountClient),
            txClient: instance(txClient),
            accountClientV4: instance(accountClientV4),
            airdropClientV4: instance(airdropClientV4),
            txClientV4: instance(txClientV4),
            kinVersion: kinVersion,
            desiredKinVersion: desiredKinVersion,
        }),
        'accountClient': accountClient,
        'txClient': txClient,
        'accountClientV4': accountClientV4,
        'airdropClientV4': airdropClientV4,
        txClientV4: txClientV4,
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
            tokenProgramAccount.setValue(tokenProgram);
            
            const resp = new transactionpbv4.GetServiceConfigResponse();
            resp.setSubsidizerAccount(subsidizerAccount);
            resp.setToken(tokenAccount);
            resp.setTokenProgram(tokenProgramAccount);
            
            const err = validateHeaders(md, "4");
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
            tokenProgramAccount.setValue(tokenProgram);
            
            const resp = new transactionpbv4.GetServiceConfigResponse();
            resp.setToken(tokenAccount);
            resp.setTokenProgram(tokenProgramAccount);
            
            const err = validateHeaders(md, "4");
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
            
            const err = validateHeaders(md, "4");
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
            
            const err = validateHeaders(md, "4");
            if (err !== undefined) {
                callback(err, undefined);
                return;
            }
            
            callback(undefined, resp);
        });
}

test('config desiredKinVersion', async() => {
    const client = newTestEnv(3, 4).client;
    const mdMap = client.metadata.getMap();
    expect(mdMap[USER_AGENT_HEADER]).toEqual(USER_AGENT);
    expect(mdMap[KIN_VERSION_HEADER]).toEqual("3");
    expect(mdMap[DESIRED_KIN_VERSION_HEADER]).toEqual("4");
});

test('getBlockchainVersion', async () => {
    const env = newTestEnv(3);
    const [client, txClientV4] = [env.client, env.txClientV4];
    when(txClientV4.getMinimumKinVersion(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const resp = new transactionpbv4.GetMinimumKinVersionResponse();
            const err = validateHeaders(md, "3");
            if (err !== undefined) {
                callback(err, undefined);
                return;
            }

            resp.setVersion(4);
            callback(undefined, resp);
        });
    expect(await client.getBlockchainVersion()).toBe(4);
});

test('createStellarAccount', async () => {
    const account = PrivateKey.random();
    const env = newTestEnv(3);
    const [client, accountClient] = [env.client, env.accountClient];

    let created = false;
    when(accountClient.createAccount(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const resp = new accountpb.CreateAccountResponse();

            const err = validateHeaders(md, "3");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            if (created) {
                resp.setResult(accountpb.CreateAccountResponse.Result.EXISTS);
            } else {
                resp.setResult(accountpb.CreateAccountResponse.Result.OK);
                created = true;
            }
            callback(undefined, resp);
        });


    await client.createStellarAccount(account);
    expect(created).toBeTruthy();

    try {
        await client.createStellarAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountExists);
    }
});

test('getStellarTransaction Kin 3', async () => {
    const env = newTestEnv(3);
    const [client, txClient] = [env.client, env.txClient];

    const testCases: {
        transaction_data: {
            tx_hash: string
            payments: {
                sender:      string
                destination: string
                type:        number
                quarks:      number
                memo?:       string
                invoice: {
                    items: {
                        title:        string
                        description?: string
                        amount:       string
                        sku?:         string
                    }[]
                }
            }[],
        },
        response: string
    }[] = JSON.parse((await fs.readFile("test/data/get_transaction_v3_test_kin_3.json")).toString());

    let currentCase = 0;
    when(txClient.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "3");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = transactionpb.GetTransactionResponse
                .deserializeBinary(Buffer.from(testCases[currentCase].response, "base64"));
            callback(undefined, resp);
        });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        const txData = await client.getStellarTransaction(Buffer.from(tc.transaction_data.tx_hash, "base64"));
        expect(txData).toBeDefined();
        expect(txData!.errors).toBeUndefined();
        expect(txData!.txId).toStrictEqual(Buffer.from(tc.transaction_data.tx_hash, "base64"));

        const expectedPayments = testCases[currentCase].transaction_data.payments.map(v => {
            const payment: ReadOnlyPayment = {
                sender: new PublicKey(Buffer.from(v.sender, "base64")),
                destination: new PublicKey(Buffer.from(v.destination, "base64")),
                type: v.type,
                quarks: new BigNumber(v.quarks).toString(),
            };
            if (v.memo) {
                payment.memo = v.memo;
            }
            if (v.invoice) {
                payment.invoice = {
                    Items: v.invoice.items.map(item => {
                        const invoiceItem: InvoiceItem = {
                            title:       item.title,
                            amount:      new BigNumber(item.amount),
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

test('getStellarTransaction Kin 2', async () => {
    const env = newTestEnv(2);
    const [client, txClient] = [env.client, env.txClient];

    const testCases: {
        transaction_data: {
            tx_hash: string
            payments: {
                sender:      string
                destination: string
                type:        number
                quarks:      number
                memo?:       string
                invoice: {
                    items: {
                        title:        string
                        description?: string
                        amount:       string
                        sku?:         string
                    }[]
                }
            }[],
        },
        response: string
    }[] = JSON.parse((await fs.readFile("test/data/get_transaction_v3_test_kin_2.json")).toString());

    let currentCase = 0;
    when(txClient.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "2");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = transactionpb.GetTransactionResponse
                .deserializeBinary(Buffer.from(testCases[currentCase].response, "base64"));
            callback(undefined, resp);
        });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        const txData = await client.getStellarTransaction(Buffer.from(tc.transaction_data.tx_hash, "base64"));
        expect(txData).toBeDefined();
        expect(txData!.errors).toBeUndefined();
        expect(txData!.txId).toStrictEqual(Buffer.from(tc.transaction_data.tx_hash, "base64"));

        const expectedPayments = testCases[currentCase].transaction_data.payments.map(v => {
            const payment: ReadOnlyPayment = {
                sender: new PublicKey(Buffer.from(v.sender, "base64")),
                destination: new PublicKey(Buffer.from(v.destination, "base64")),
                type: v.type,
                quarks: new BigNumber(v.quarks).toString(),
            };
            if (v.memo) {
                payment.memo = v.memo;
            }
            if (v.invoice) {
                payment.invoice = {
                    Items: v.invoice.items.map(item => {
                        const invoiceItem: InvoiceItem = {
                            title:       item.title,
                            amount:      new BigNumber(item.amount),
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

test('submitStellarTranaction', async () => {
    const env = newTestEnv(3);
    const [client, txClient] = [env.client, env.txClient];

    const hash = Buffer.from("XAoFvA3J/n9+VnQ1/UheMTJx+VBbEkeeQ8i8WJUoxkQ=", "base64");
    const envelopeBytes = Buffer.from("AAAAAKiU54hhLR7yt7yGloTK6yrLPMXbm6v8z3qTwN7Wx81QAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAColOeIYS0e8re8hpaEyusqyzzF25ur/M96k8De1sfNUAAAAAEAAAAAXpMpylSzJtiXOe+Qel7MmgWqc+AwelwYBUeAvTf46VQAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64");
    let invoiceList: commonpb.InvoiceList | undefined = undefined;

    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpb.SubmitTransactionRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "3");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            expect(req.getEnvelopeXdr()).toStrictEqual(envelopeBytes);
            expect(req.getInvoiceList()).toBe(invoiceList);

            const txHash = new commonpb.TransactionHash();
            txHash.setValue(hash);

            const resp = new transactionpb.SubmitTransactionResponse();
            resp.setResult(transactionpb.SubmitTransactionResponse.Result.OK);
            resp.setHash(txHash);

            callback(undefined, resp);
        });

    let resp = await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
    expect(resp.TxId).toStrictEqual(hash);
    expect(resp.InvoiceErrors).toBeUndefined();
    expect(resp.Errors).toBeUndefined();

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

    resp = await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes), invoiceList);
    expect(resp.TxId).toStrictEqual(hash);
    expect(resp.InvoiceErrors).toBeUndefined();
    expect(resp.Errors).toBeUndefined();
});
test('submitStellarTransaction failed', async () => {
    const env = newTestEnv(3);
    const [client, txClient] = [env.client, env.txClient];

    const hash = Buffer.from("XAoFvA3J/n9+VnQ1/UheMTJx+VBbEkeeQ8i8WJUoxkQ=", "base64");
    const envelopeBytes = Buffer.from("AAAAAKiU54hhLR7yt7yGloTK6yrLPMXbm6v8z3qTwN7Wx81QAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAColOeIYS0e8re8hpaEyusqyzzF25ur/M96k8De1sfNUAAAAAEAAAAAXpMpylSzJtiXOe+Qel7MmgWqc+AwelwYBUeAvTf46VQAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64");
    const resultBytes = Buffer.from("AAAAAAAAAAD////6AAAAAA==", "base64");

    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const txHash = new commonpb.TransactionHash();
            txHash.setValue(hash);

            const resp = new transactionpb.SubmitTransactionResponse();
            resp.setHash(txHash);
            resp.setResult(transactionpb.SubmitTransactionResponse.Result.FAILED);
            resp.setResultXdr(resultBytes);

            callback(undefined, resp);
        });

    const resp = await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
    expect(resp.TxId).toStrictEqual(hash);
    expect(resp.InvoiceErrors).toBeUndefined();
    expect(resp.Errors?.TxError).toBeInstanceOf(InvalidSignature);
});
test('submitStellarTransaction rejected', async () => {
    const env = newTestEnv(3);
    const [client, txClient] = [env.client, env.txClient];

    const hash = Buffer.from("XAoFvA3J/n9+VnQ1/UheMTJx+VBbEkeeQ8i8WJUoxkQ=", "base64");
    const envelopeBytes = Buffer.from("AAAAAKiU54hhLR7yt7yGloTK6yrLPMXbm6v8z3qTwN7Wx81QAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAColOeIYS0e8re8hpaEyusqyzzF25ur/M96k8De1sfNUAAAAAEAAAAAXpMpylSzJtiXOe+Qel7MmgWqc+AwelwYBUeAvTf46VQAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64");

    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const txHash = new commonpb.TransactionHash();
            txHash.setValue(hash);

            const resp = new transactionpb.SubmitTransactionResponse();
            resp.setHash(txHash);
            resp.setResult(transactionpb.SubmitTransactionResponse.Result.REJECTED);

            callback(undefined, resp);
        });

    try {
        await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(TransactionRejected);
    }
});
test('submitStellarTransaction invoice error', async () => {
    const env = newTestEnv(3);
    const [client, txClient] = [env.client, env.txClient];

    const hash = Buffer.from("XAoFvA3J/n9+VnQ1/UheMTJx+VBbEkeeQ8i8WJUoxkQ=", "base64");
    const envelopeBytes = Buffer.from("AAAAAKiU54hhLR7yt7yGloTK6yrLPMXbm6v8z3qTwN7Wx81QAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAColOeIYS0e8re8hpaEyusqyzzF25ur/M96k8De1sfNUAAAAAEAAAAAXpMpylSzJtiXOe+Qel7MmgWqc+AwelwYBUeAvTf46VQAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64");

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

    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const txHash = new commonpb.TransactionHash();
            txHash.setValue(hash);

            const invoiceErrors = new Array<commonpb.InvoiceError>(3);
            for (let i = 0; i < 3; i++) {
                invoiceErrors[i] = new commonpb.InvoiceError();
                invoiceErrors[i].setOpIndex(i);
                invoiceErrors[i].setReason(i + 1);
                invoiceErrors[i].setInvoice(invoices[i]);
            }

            const resp = new transactionpb.SubmitTransactionResponse();
            resp.setHash(txHash);
            resp.setResult(transactionpb.SubmitTransactionResponse.Result.INVOICE_ERROR);
            resp.setInvoiceErrorsList(invoiceErrors);

            callback(undefined, resp);
        });

    const resp = await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
    expect(resp.Errors).toBeUndefined();
    expect(resp.InvoiceErrors).toHaveLength(3);
    resp.InvoiceErrors?.forEach((err, i) => {
        expect(err.getOpIndex()).toBe(i);
        expect(err.getReason()).toBe((i + 1) as commonpb.InvoiceError.Reason);
        expect(err.getInvoice()).toBe(invoices[i]);
    });
});

test('createSolanaAccount', async () => {
    const account = PrivateKey.random();
    const tokenAccount = generateTokenAccount(account);

    const env = newTestEnv(4);
    const [client, accountClientV4, txClientV4] = [env.client, env.accountClientV4, env.txClientV4];

    setGetServiceConfigResp(txClientV4);
    setGetRecentBlockhashResp(txClientV4);
    setGetMinBalanceResp(txClientV4);

    let created = false;
    when(accountClientV4.createAccount(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.CreateAccountRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "4");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.CreateAccountResponse();
            if (created) {
                resp.setResult(accountpbv4.CreateAccountResponse.Result.EXISTS);
            } else {
                const tx = SolanaTransaction.from(req.getTransaction()!.getValue_asU8());
                expect(tx.signatures).toHaveLength(3);
                expect(tx.signatures[0].publicKey.toBuffer()).toEqual(subsidizer);
                expect(tx.signatures[0].signature).toBeNull();

                expect(tx.signatures[1].publicKey.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(tokenAccount.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();
                
                expect(tx.signatures[2].publicKey.toBuffer()).toEqual(account.publicKey().buffer);
                expect(account.kp.verify(tx.serializeMessage(), tx.signatures[2].signature!)).toBeTruthy();

                expect(tx.instructions).toHaveLength(3);
                const tokenProgramKey = new SolanaPublicKey(tokenProgram);
                
                const createInstruction = SystemInstruction.decodeCreateAccount(tx.instructions[0]);
                expect(createInstruction.fromPubkey.toBuffer()).toEqual(subsidizer);
                expect(createInstruction.newAccountPubkey.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(createInstruction.programId).toEqual(tokenProgramKey);
                expect(createInstruction.lamports).toEqual(minBalanceForRentExemption);
                expect(createInstruction.space).toEqual(AccountSize);

                const initInstruction = TokenInstruction.decodeInitializeAccount(tx.instructions[1], tokenProgramKey);
                expect(initInstruction.account.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(initInstruction.mint.toBuffer()).toEqual(token);
                expect(initInstruction.owner.toBuffer()).toEqual(account.publicKey().buffer);

                const setAuthInstruction = TokenInstruction.decodeSetAuthority(tx.instructions[2], tokenProgramKey);
                expect(setAuthInstruction.account.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(setAuthInstruction.currentAuthority.toBuffer()).toEqual(account.publicKey().buffer);
                expect(setAuthInstruction.newAuthority!.toBuffer()).toEqual(subsidizer);
                expect(setAuthInstruction.authorityType).toEqual(AuthorityType.CloseAccount);
                
                resp.setResult(accountpbv4.CreateAccountResponse.Result.OK);
                created = true;
            }
            callback(undefined, resp);
        });

    await client.createSolanaAccount(account);
    expect(created).toBeTruthy();

    try {
        await client.createSolanaAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountExists);
    }
});
test('createSolanaAccount no service subsidizer', async () => {
    const account = PrivateKey.random();
    const tokenAccount = generateTokenAccount(account);
    
    const appSubsidizer = PrivateKey.random();
    const env = newTestEnv(4);
    const [client, accountClientV4, txClientV4] = [env.client, env.accountClientV4, env.txClientV4];

    setGetServiceConfigRespNoSubsidizer(txClientV4);
    setGetRecentBlockhashResp(txClientV4);
    setGetMinBalanceResp(txClientV4);

    let created = false;
    when(accountClientV4.createAccount(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.CreateAccountRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "4");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.CreateAccountResponse();
            if (created) {
                resp.setResult(accountpbv4.CreateAccountResponse.Result.EXISTS);
            } else {
                const tx = SolanaTransaction.from(req.getTransaction()!.getValue_asU8());
                expect(tx.signatures).toHaveLength(3);
                expect(tx.signatures[0].publicKey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
                expect(appSubsidizer.kp.verify(tx.serializeMessage(), tx.signatures[0].signature!)).toBeTruthy();

                expect(tx.signatures[1].publicKey.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(tokenAccount.kp.verify(tx.serializeMessage(), tx.signatures[1].signature!)).toBeTruthy();

                expect(tx.signatures[2].publicKey.toBuffer()).toEqual(account.publicKey().buffer);
                expect(account.kp.verify(tx.serializeMessage(), tx.signatures[2].signature!)).toBeTruthy();

                expect(tx.instructions).toHaveLength(3);
                const tokenProgramKey = new SolanaPublicKey(tokenProgram);
                
                const createInstruction = SystemInstruction.decodeCreateAccount(tx.instructions[0]);
                expect(createInstruction.fromPubkey.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
                expect(createInstruction.newAccountPubkey.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(createInstruction.programId).toEqual(tokenProgramKey);
                expect(createInstruction.lamports).toEqual(minBalanceForRentExemption);
                expect(createInstruction.space).toEqual(AccountSize);

                const initInstruction = TokenInstruction.decodeInitializeAccount(tx.instructions[1], tokenProgramKey);
                expect(initInstruction.account.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(initInstruction.mint.toBuffer()).toEqual(token);
                expect(initInstruction.owner.toBuffer()).toEqual(account.publicKey().buffer);

                const setAuthInstruction = TokenInstruction.decodeSetAuthority(tx.instructions[2], tokenProgramKey);
                expect(setAuthInstruction.account.toBuffer()).toEqual(tokenAccount.publicKey().buffer);
                expect(setAuthInstruction.currentAuthority.toBuffer()).toEqual(account.publicKey().buffer);
                expect(setAuthInstruction.newAuthority!.toBuffer()).toEqual(appSubsidizer.publicKey().buffer);
                expect(setAuthInstruction.authorityType).toEqual(AuthorityType.CloseAccount);
                
                resp.setResult(accountpbv4.CreateAccountResponse.Result.OK);
                created = true;
            }
            callback(undefined, resp);
        });

    try {
        await client.createSolanaAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(NoSubsidizerError);
    }

    await client.createSolanaAccount(account, undefined, appSubsidizer);
    expect(created).toBeTruthy();
});
test('createSolanaAccount errors', async () => {
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
    const env = newTestEnv(4);
    const [client, accountClientV4, txClientV4] = [env.client, env.accountClientV4, env.txClientV4];

    setGetServiceConfigResp(txClientV4);
    setGetRecentBlockhashResp(txClientV4);
    setGetMinBalanceResp(txClientV4);

    let currentCase = 0;
    when(accountClientV4.createAccount(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "4");
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
            await client.createSolanaAccount(account);
            fail();
        } catch (err) {
            expect(err).toBeInstanceOf(tc.error);
        }
    }
});

test('getSolanaAccountInfo', async() => {
    const account1 = PrivateKey.random().publicKey();
    const account2 = PrivateKey.random().publicKey();
    const env = newTestEnv(4);
    const [client, accountClientV4] = [env.client, env.accountClientV4];

    when(accountClientV4.getAccountInfo(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.GetAccountInfoRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "4");
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

    const info = await client.getSolanaAccountInfo(account1);
    expect(info.getAccountId()!.getValue()).toEqual(account1.buffer);
    expect(info.getBalance()).toEqual("100");

    try {
        await client.getSolanaAccountInfo(account2);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountDoesNotExist);
    }
});

test('internal retry', async () => {
    const env = newTestEnv(3);
    const [client, accountClient, txClient, txClientV4] = [env.client, env.accountClient, env.txClient, env.txClientV4];

    const account = PrivateKey.random();

    when(accountClient.createAccount(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new accountpb.CreateAccountRequest());
        });
    when(accountClient.getAccountInfo(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new accountpb.GetAccountInfoResponse());
        });
    when(txClientV4.getTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new transactionpb.GetTransactionResponse());
        });
    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            };
            callback(err, new transactionpb.SubmitTransactionResponse());
        });

    try {
        await client.createStellarAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(accountClient.createAccount(anything(), anything(), anything())).times(3);

    try {
        await client.getAccountInfo(new PublicKey(Buffer.alloc(32)));
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(accountClient.createAccount(anything(), anything(), anything())).times(3);

    try {
        await client.getTransaction(Buffer.alloc(32));
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClientV4.getTransaction(anything(), anything(), anything())).times(3);

    try {
        const envelopeBytes = Buffer.from("AAAAAKiU54hhLR7yt7yGloTK6yrLPMXbm6v8z3qTwN7Wx81QAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAColOeIYS0e8re8hpaEyusqyzzF25ur/M96k8De1sfNUAAAAAEAAAAAXpMpylSzJtiXOe+Qel7MmgWqc+AwelwYBUeAvTf46VQAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64");
        await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClient.submitTransaction(anything(), anything(), anything())).times(3);
});

test('getTransaction Kin 3', async () => {
    const env = newTestEnv(3);
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
            const err = validateHeaders(md, "3");
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
    const env = newTestEnv(2);
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
            const err = validateHeaders(md, "2");
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
    const env = newTestEnv(4);
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
            const err = validateHeaders(md, "4");
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
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];

    when(txClientV4.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "4");
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

test('submitSolanaTransaction', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const sig = Buffer.from("somesig");
    const transaction = new SolanaTransaction({ 
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: sender.solanaKey(),
            amount: BigInt(100),
        }, new PublicKey(tokenProgram).solanaKey(),
    ));

    let invoiceList: commonpb.InvoiceList | undefined = undefined;

    let submitted: transactionpbv4.SubmitTransactionRequest | undefined;
    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpbv4.SubmitTransactionRequest, md: grpc.Metadata, callback) => {
            submitted = req;
            const err = validateHeaders(md, "4");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            expect(Buffer.from(req.getTransaction()!.getValue_asU8())).toStrictEqual(transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            }));
            expect(req.getInvoiceList()).toBe(invoiceList);

            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(sig);

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.OK);
            resp.setSignature(txSig);

            callback(undefined, resp);
        });

    let result = await client.submitSolanaTransaction(transaction);
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

    result = await client.submitSolanaTransaction(transaction, invoiceList);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
    expect(result.Errors).toBeUndefined();

    expect(submitted).toBeDefined();
    expect(submitted!.getTransaction()).toBeDefined();
    expect(submitted!.getTransaction()!.getValue()).toEqual(transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
    }));
    expect(submitted!.getInvoiceList()).toEqual(invoiceList);
    expect(submitted!.getCommitment()).toEqual(commonpbv4.Commitment.SINGLE);  // default
    expect(submitted!.getDedupeId()).toEqual("");

    // Submit with all options
    const dedupeId = Buffer.from(uuidv4());
    result = await client.submitSolanaTransaction(transaction, invoiceList, Commitment.Max, dedupeId);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
    expect(result.Errors).toBeUndefined();

    expect(submitted).toBeDefined();
    expect(submitted!.getTransaction()).toBeDefined();
    expect(submitted!.getTransaction()!.getValue()).toEqual(transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
    }));
    expect(submitted!.getInvoiceList()).toEqual(invoiceList);
    expect(submitted!.getCommitment()).toEqual(commonpbv4.Commitment.MAX);
    expect(Buffer.from(submitted!.getDedupeId())).toEqual(dedupeId);
});
test('submitSolanaTransaction already submitted', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const sig = Buffer.from("somesig");
    const transaction = new SolanaTransaction({ 
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: sender.solanaKey(),
            amount: BigInt(100),
        }, new PublicKey(tokenProgram).solanaKey(),
    ));

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
        await client.submitSolanaTransaction(transaction);
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

    const result = await client.submitSolanaTransaction(transaction);
    expect(result.TxId).toStrictEqual(sig);
    expect(result.InvoiceErrors).toBeUndefined();
    expect(result.Errors).toBeUndefined();
});
test('submitSolanaTransaction failed', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const sig = Buffer.from("somesig");
    const transaction = new SolanaTransaction({ 
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: sender.solanaKey(),
            amount: BigInt(100),
        }, new PublicKey(tokenProgram).solanaKey(),
    ));

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

    const resp = await client.submitSolanaTransaction(transaction);
    expect(resp.TxId).toStrictEqual(sig);
    expect(resp.InvoiceErrors).toBeUndefined();
    expect(resp.Errors?.OpErrors![0]).toBeInstanceOf(BadNonce);
});
test('submitSolanaTransaction rejected', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const sig = Buffer.from("somesig");
    const transaction = new SolanaTransaction({ 
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: sender.solanaKey(),
            amount: BigInt(100),
        }, new PublicKey(tokenProgram).solanaKey(),
    ));

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(sig);

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setSignature(txSig);
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.REJECTED);

            callback(undefined, resp);
        });

    try {
        await client.submitSolanaTransaction(transaction);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(TransactionRejected);
    }
});
test('submitSolanaTransaction payer required', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const sig = Buffer.from("somesig");
    const transaction = new SolanaTransaction({ 
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: sender.solanaKey(),
            amount: BigInt(100),
        }, new PublicKey(tokenProgram).solanaKey(),
    ));

    when(txClientV4.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(sig);

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setSignature(txSig);
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.PAYER_REQUIRED);

            callback(undefined, resp);
        });

    try {
        await client.submitSolanaTransaction(transaction);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(PayerRequired);
    }
});
test('submitSolanaTransaction invoice error', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];
    const [sender, destination] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];

    const sig = Buffer.from("somesig");
    const transaction = new SolanaTransaction({ 
        feePayer: sender.solanaKey(),
        recentBlockhash: new PublicKey(recentBlockhash).toBase58(),
    }).add(
        TokenProgram.transfer({
            source: sender.solanaKey(),
            dest: destination.solanaKey(),
            owner: sender.solanaKey(),
            amount: BigInt(100),
        }, new PublicKey(tokenProgram).solanaKey(),
    ));

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
            const txSig = new commonpbv4.TransactionSignature();
            txSig.setValue(sig);

            const invoiceErrors = new Array<commonpb.InvoiceError>(3);
            for (let i = 0; i < 3; i++) {
                invoiceErrors[i] = new commonpb.InvoiceError();
                invoiceErrors[i].setOpIndex(i);
                invoiceErrors[i].setReason(i + 1);
                invoiceErrors[i].setInvoice(invoices[i]);
            }

            const resp = new transactionpbv4.SubmitTransactionResponse();
            resp.setSignature(txSig);
            resp.setResult(transactionpbv4.SubmitTransactionResponse.Result.INVOICE_ERROR);
            resp.setInvoiceErrorsList(invoiceErrors);

            callback(undefined, resp);
        });

    const resp = await client.submitSolanaTransaction(transaction);
    expect(resp.Errors).toBeUndefined();
    expect(resp.InvoiceErrors).toHaveLength(3);
    resp.InvoiceErrors?.forEach((err, i) => {
        expect(err.getOpIndex()).toBe(i);
        expect(err.getReason()).toBe((i + 1) as commonpb.InvoiceError.Reason);
        expect(err.getInvoice()).toBe(invoices[i]);
    });
});

test('getServiceConfig', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];

    setGetServiceConfigResp(txClientV4);
    
    const resp = await client.getServiceConfig();
    expect(Buffer.from(resp.getSubsidizerAccount()!.getValue_asU8())).toEqual(subsidizer);
    expect(Buffer.from(resp.getToken()!.getValue_asU8())).toEqual(token);
    expect(Buffer.from(resp.getTokenProgram()!.getValue_asU8())).toEqual(tokenProgram);
    
    await client.getServiceConfig();
    
    // Verify that only one request was submitted
    verify(txClientV4.getServiceConfig(anything(), anything(), anything())).times(1);
});

test('getRecentBlockhash', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];

    setGetRecentBlockhashResp(txClientV4);

    const result = await client.getRecentBlockhash();
    expect(result).toEqual(bs58.encode(recentBlockhash));
});

test('getMinimumBalanceForRentExemption', async () => {
    const env = newTestEnv(4);
    const [client, txClientV4] = [env.client, env.txClientV4];

    setGetMinBalanceResp(txClientV4);

    const result = await client.getMinimumBalanceForRentExemption();
    expect(result).toEqual(minBalanceForRentExemption);
});

test('requestAirdrop', async() => {
    const env = newTestEnv(4);
    const [client, airdropClientV4] = [env.client, env.airdropClientV4];

    const [account1, account2] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];
    const txSig = Buffer.from("sometxsig");
    
    when(airdropClientV4.requestAirdrop(anything(), anything(), anything()))
        .thenCall((req: airdroppbv4.RequestAirdropRequest, md, callback) => {
            const err = validateHeaders(md, "4");
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

test('resolveTokenAccounts', async() => {
    const env = newTestEnv(4);
    const [client, accountClientV4] = [env.client, env.accountClientV4];

    const [account, token1, token2] = [PrivateKey.random().publicKey(), PrivateKey.random().publicKey(), PrivateKey.random().publicKey()];
    
    when (accountClientV4.resolveTokenAccounts(anything(), anything(), anything()))
        .thenCall((req: accountpbv4.ResolveTokenAccountsRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "4");
            if (err != undefined) {
                callback(err, undefined);
                return;
            }

            const resp = new accountpbv4.ResolveTokenAccountsResponse();
            if (Buffer.from(req.getAccountId()!.getValue_asU8()).equals(account.buffer)) {
                const tokenAccount1 = new commonpbv4.SolanaAccountId();
                tokenAccount1.setValue(token1.buffer);
                const tokenAccount2 = new commonpbv4.SolanaAccountId();
                tokenAccount2.setValue(token2.buffer);

                resp.setTokenAccountsList([tokenAccount1, tokenAccount2]);
            }
            callback(undefined, resp);
        });

    const tokens = await client.resolveTokenAccounts(account);
    expect(tokens[0]).toEqual(token1);
    expect(tokens[1]).toEqual(token2);

    expect(await client.resolveTokenAccounts(token1)).toHaveLength(0);
});

test('internal retry Kin 4', async () => {
    let env = newTestEnv(4);
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
        await client.createSolanaAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(accountClientV4.createAccount(anything(), anything(), anything())).times(3);

    try {
        await client.getSolanaAccountInfo(new PublicKey(Buffer.alloc(32)));
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
        TokenProgram.transfer({
            source: PrivateKey.random().publicKey().solanaKey(),
            dest: PrivateKey.random().publicKey().solanaKey(),
            owner: PrivateKey.random().publicKey().solanaKey(),
            amount: BigInt(100),
        }, new PublicKey(tokenProgram).solanaKey(),
    ));
    try {
        await client.submitSolanaTransaction(transaction);
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

    env = newTestEnv(4);
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
