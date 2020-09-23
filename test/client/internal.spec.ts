import grpc from "grpc";
import { promises as fs } from "fs";
import { BigNumber } from "bignumber.js";
import {mock, when, anything, instance, verify} from "ts-mockito";

import accountpb from "@kinecosystem/agora-api/node/account/v3/account_service_pb";
import accountgrpc from "@kinecosystem/agora-api/node/account/v3/account_service_grpc_pb";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import transactionpb from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_pb";
import transactiongrpc from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_grpc_pb";

import { InternalClient } from "../../src/client";
import {USER_AGENT_HEADER, USER_AGENT, KIN_VERSION_HEADER} from "../../src/client/internal";
import { xdr } from "stellar-base";
import { AccountExists, InvalidSignature, TransactionRejected } from "../../src/errors";
import {
    PrivateKey,
    PublicKey,
    ReadOnlyPayment,
    InvoiceItem,
    invoiceToProto,
 } from "../../src";

function validateHeaders(md: grpc.Metadata, expectedVersion: string): grpc.ServiceError | undefined {
    const mdMap = md.getMap();
    if (mdMap[USER_AGENT_HEADER] !== USER_AGENT) {
        return {
            name: "",
            message: "missing kin-user-agent",
            code: grpc.status.INVALID_ARGUMENT,
        }
    }

    if (mdMap[KIN_VERSION_HEADER] !== expectedVersion) {
        return {
            name: "",
            message: "incorrect kin_version",
            code: grpc.status.INVALID_ARGUMENT,
        }
    }

    return undefined
}

test('getBlockchainVersion', async () => {
    const accountClient = mock(accountgrpc.AccountClient);
    const txClient = mock(transactiongrpc.TransactionClient)
    let client = new InternalClient({
        accountClient: instance(accountClient),
        txClient: instance(txClient),
    })
    expect(await client.getBlockchainVersion()).toBe(3);

    client = new InternalClient({
        accountClient: instance(accountClient),
        txClient: instance(txClient),
        kinVersion: 2,
    })
    expect(await client.getBlockchainVersion()).toBe(2)
})

test('createStellarAccount', async () => {
    const account = PrivateKey.random();
    const accountClient = mock(accountgrpc.AccountClient)
    const txClient = mock(transactiongrpc.TransactionClient)

    let created = false;
    when(accountClient.createAccount(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const resp = new accountpb.CreateAccountResponse();

            const err = validateHeaders(md, "3");
            if (err != undefined) {
                callback(err, undefined);
                return
            }

            if (created) {
                resp.setResult(accountpb.CreateAccountResponse.Result.EXISTS);
            } else {
                resp.setResult(accountpb.CreateAccountResponse.Result.OK);
                created = true;
            }
            callback(undefined, resp);
        });

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient) });

    await client.createStellarAccount(account);
    expect(created).toBeTruthy();

    try {
        await client.createStellarAccount(account);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(AccountExists);
    }
})

test('getTransaction', async () => {
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
    }[] = JSON.parse((await fs.readFile("test/data/get_transaction_test.json")).toString());

    const accountClient = mock(accountgrpc.AccountClient)
    const txClient = mock(transactiongrpc.TransactionClient)

    let currentCase = 0;
    when(txClient.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "3");
            if (err != undefined) {
                callback(err, undefined);
                return
            }

            const resp = transactionpb.GetTransactionResponse
                .deserializeBinary(Buffer.from(testCases[currentCase].response, "base64"));
            callback(undefined, resp);
        });

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient) });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        const txData = await client.getTransaction(Buffer.from(tc.transaction_data.tx_hash, "base64"));
        expect(txData).toBeDefined();
        expect(txData!.errors).toBeUndefined();
        expect(txData!.txHash).toStrictEqual(Buffer.from(tc.transaction_data.tx_hash, "base64"));

        const expectedPayments = testCases[currentCase].transaction_data.payments.map(v => {
            const payment: ReadOnlyPayment = {
                sender: new PublicKey(Buffer.from(v.sender, "base64")),
                destination: new PublicKey(Buffer.from(v.destination, "base64")),
                type: v.type,
                quarks: new BigNumber(v.quarks).toString(),
            };
            if (v.memo) {
                payment.memo = v.memo
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
})

test('getTransaction Kin 2', async () => {
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
    }[] = JSON.parse((await fs.readFile("test/data/get_transaction_test_kin_2.json")).toString());

    const accountClient = mock(accountgrpc.AccountClient)
    const txClient = mock(transactiongrpc.TransactionClient)

    let currentCase = 0;
    when(txClient.getTransaction(anything(), anything(), anything()))
        .thenCall((_, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "2");
            if (err != undefined) {
                callback(err, undefined);
                return
            }

            const resp = transactionpb.GetTransactionResponse
                .deserializeBinary(Buffer.from(testCases[currentCase].response, "base64"));
            callback(undefined, resp);
        });

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient), kinVersion: 2 });

    for (let i = 0; i < testCases.length; i++) {
        currentCase = i;
        const tc = testCases[i];

        const txData = await client.getTransaction(Buffer.from(tc.transaction_data.tx_hash, "base64"));
        expect(txData).toBeDefined();
        expect(txData!.errors).toBeUndefined();
        expect(txData!.txHash).toStrictEqual(Buffer.from(tc.transaction_data.tx_hash, "base64"));

        const expectedPayments = testCases[currentCase].transaction_data.payments.map(v => {
            const payment: ReadOnlyPayment = {
                sender: new PublicKey(Buffer.from(v.sender, "base64")),
                destination: new PublicKey(Buffer.from(v.destination, "base64")),
                type: v.type,
                quarks: new BigNumber(v.quarks).toString(),
            };
            if (v.memo) {
                payment.memo = v.memo
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
})

test('submitStellarTranaction', async () => {
    const accountClient = mock(accountgrpc.AccountClient);
    const txClient = mock(transactiongrpc.TransactionClient);

    const hash = Buffer.from("XAoFvA3J/n9+VnQ1/UheMTJx+VBbEkeeQ8i8WJUoxkQ=", "base64");
    const envelopeBytes = Buffer.from("AAAAAKiU54hhLR7yt7yGloTK6yrLPMXbm6v8z3qTwN7Wx81QAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAColOeIYS0e8re8hpaEyusqyzzF25ur/M96k8De1sfNUAAAAAEAAAAAXpMpylSzJtiXOe+Qel7MmgWqc+AwelwYBUeAvTf46VQAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64");
    let invoiceList: commonpb.InvoiceList;

    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((req: transactionpb.SubmitTransactionRequest, md: grpc.Metadata, callback) => {
            const err = validateHeaders(md, "3");
            if (err != undefined) {
                callback(err, undefined);
                return
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

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient) });

    let resp = await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
    expect(resp.TxHash).toStrictEqual(hash);
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
    expect(resp.TxHash).toStrictEqual(hash);
    expect(resp.InvoiceErrors).toBeUndefined();
    expect(resp.Errors).toBeUndefined();
})
test('submitStellarTransaction failed', async() => {
    const accountClient = mock(accountgrpc.AccountClient);
    const txClient = mock(transactiongrpc.TransactionClient);
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

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient) });
    const resp = await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
    expect(resp.TxHash).toStrictEqual(hash);
    expect(resp.InvoiceErrors).toBeUndefined();
    expect(resp.Errors?.TxError).toBeInstanceOf(InvalidSignature);
})
test('submitStellarTransaction rejected', async() => {
    const accountClient = mock(accountgrpc.AccountClient);
    const txClient = mock(transactiongrpc.TransactionClient);
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

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient) });

    try {
        await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(TransactionRejected);
    }
})
test('submitStellarTransaction invoice error', async() => {
    const accountClient = mock(accountgrpc.AccountClient);
    const txClient = mock(transactiongrpc.TransactionClient);

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
    ]

    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const txHash = new commonpb.TransactionHash();
            txHash.setValue(hash);

            const invoiceErrors = new Array<transactionpb.SubmitTransactionResponse.InvoiceError>(3);
            for (let i = 0; i < 3; i++) {
                invoiceErrors[i] = new transactionpb.SubmitTransactionResponse.InvoiceError();
                invoiceErrors[i].setOpIndex(i);
                invoiceErrors[i].setReason(i+1);
                invoiceErrors[i].setInvoice(invoices[i]);
            }

            const resp = new transactionpb.SubmitTransactionResponse();
            resp.setHash(txHash);
            resp.setResult(transactionpb.SubmitTransactionResponse.Result.INVOICE_ERROR);
            resp.setInvoiceErrorsList(invoiceErrors);

            callback(undefined, resp);
        });

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient) });

    const resp = await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
    expect(resp.Errors).toBeUndefined();
    expect(resp.InvoiceErrors).toHaveLength(3);
    resp.InvoiceErrors?.forEach((err, i) => {
        expect(err.getOpIndex()).toBe(i);
        expect(err.getReason()).toBe((i +1) as transactionpb.SubmitTransactionResponse.InvoiceError.Reason);
        expect(err.getInvoice()).toBe(invoices[i]);
    });
})

test('internal retry', async() => {
    const account = PrivateKey.random();
    const accountClient = mock(accountgrpc.AccountClient)
    const txClient = mock(transactiongrpc.TransactionClient)

    when(accountClient.createAccount(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            }
            callback(err, new accountpb.CreateAccountRequest());
        });
    when(accountClient.getAccountInfo(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            }
            callback(err, new accountpb.GetAccountInfoResponse());
        });
    when(txClient.getTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            }
            callback(err, new transactionpb.GetTransactionResponse());
        });
    when(txClient.submitTransaction(anything(), anything(), anything()))
        .thenCall((_, __, callback) => {
            const err: grpc.ServiceError = {
                name: "",
                message: "",
                code: grpc.status.INTERNAL,
            }
            callback(err, new transactionpb.SubmitTransactionResponse());
        });

    const client = new InternalClient({ accountClient: instance(accountClient), txClient: instance(txClient) });

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
    verify(txClient.getTransaction(anything(), anything(), anything())).times(3);

    try {
        const envelopeBytes = Buffer.from("AAAAAKiU54hhLR7yt7yGloTK6yrLPMXbm6v8z3qTwN7Wx81QAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAQAAAAColOeIYS0e8re8hpaEyusqyzzF25ur/M96k8De1sfNUAAAAAEAAAAAXpMpylSzJtiXOe+Qel7MmgWqc+AwelwYBUeAvTf46VQAAAAAAAAAAAAAAAoAAAAAAAAAAA==", "base64");
        await client.submitStellarTransaction(xdr.TransactionEnvelope.fromXDR(envelopeBytes));
        fail();
    } catch (err) {
        expect(err).toBeDefined();
    }
    verify(txClient.submitTransaction(anything(), anything(), anything())).times(3);
})
