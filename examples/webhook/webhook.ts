import express from "express";
import { Keypair } from "stellar-base";
import { Environment, PrivateKey } from "../../src";
import { Event, EventsHandler, SignTransactionHandler, SignTransactionRequest, SignTransactionResponse } from "../../src/webhook";

const port = process.env["PORT"];
const secret = process.env["WEBHOOK_SECRET"];
const whitelistSeed = process.env["WHITELIST_SEED"];

if (!whitelistSeed) {
    console.log("missing whitelist seed");
    process.exit(1);
}

const whitelistKey = PrivateKey.fromString(whitelistSeed);

const app = express();

app.use("/events", express.json());
app.use("/events", EventsHandler((events: Event[]) => {
    for (let e of events) {
        console.log(`received event: ${JSON.stringify(e)}`)
    }
}, secret));

app.use("/sign_transaction", express.json())
app.use("/sign_transaction", SignTransactionHandler(Environment.Test, (req: SignTransactionRequest, resp: SignTransactionResponse) => {
    console.log(`sign request for <'${req.userId}', '${req.userPassKey}'>: ${req.txHash().toString('hex')}`);

    for (let i = 0; i < req.payments.length; i++) {
        const p = req.payments[i];

        // Double check that the transaction isn't trying to impersonate us
        if (p.sender.equals(whitelistKey.publicKey())) {
            resp.reject();
            return;
        }

        // In this example, we don't want to whitelist transactions that aren't sending
        // kin to us.
        if (p.destination.equals(whitelistKey.publicKey())) {
            resp.markWrongDestination(i);
        }

        if (p.invoice) {
            for (let item of p.invoice.Items) {
                if (!item.sku) {
                    // Note: in general the sku is optional. Howver, in this example we
                    //       mark it as SkuNotFound to faciliate testing. 
                    resp.markSkuNotFound(i);
                }
            }
        }
    }

    // Note: if we _don't_ do this check here, the SDK won't send back a signed
    //       transaction if this is set.
    if (resp.isRejected()) {
        return;
    }

    // Note: if we didn't sign or reject, then the transaction will still go through,
    //       but fees will be charged.
    resp.sign(new PrivateKey(Keypair.random()));
}, secret))


app.listen(port, () => {
    console.log(`server started at http://localhost:${ port }`);
})
