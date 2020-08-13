import { constantDelay, linearDelay, expontentialDelay, binaryExpotentialDelay, limit, retriableErrors, nonRetriableErrors, backoff, retryAsync, backoffWithJitter} from "../../src/retry";
import { AccountDoesNotExist, BadNonce } from "../../src/errors";
import { retry } from "../../src/retry";

test("delayFunctions", () => {
    for (let i = 0; i < 5; i++) {
        expect(constantDelay(1.5)(i)).toBe(1.5);
        expect(linearDelay(1.5)(i)).toBe(i*1.5);
    }

    for (let i = 1; i <= 4; i++) {
        expect(expontentialDelay(2, 3.0)(i)).toBe(2 * Math.pow(3, i-1))
    }

    for (let i = 1; i <= 4; i++) {
        expect(binaryExpotentialDelay(1.5)(i)).toBe(expontentialDelay(1.5, 2)(i))
    }
})

test("strategies", async () => {
    // We perform an action, then check retry logic.
    // As a result, if our max attempts is 2, we should
    // only retry once. 
    //
    // This is since we're measuring "max attemts", not
    // "max retries".
    expect(await limit(2)(1, new Error())).toBeTruthy();
    expect(await limit(2)(2, new Error())).toBeFalsy();

    const errors: any[] = [
        AccountDoesNotExist,
        BadNonce,
    ];

    for (const e of errors) {
        expect(await retriableErrors(...errors)(1, new e())).toBeTruthy();
        expect(await nonRetriableErrors(...errors)(1, new e())).toBeFalsy();
    }

    expect(await retriableErrors(...errors)(1, new Error())).toBeFalsy();
    expect(await nonRetriableErrors(...errors)(1, new Error())).toBeTruthy();

    let start = new Date().getTime();
    expect(await backoff(constantDelay(0.5), 0.5)(10, new Error())).toBeTruthy();
    let elapsed = new Date().getTime() - start;

    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(1000);

    start = new Date().getTime();
    expect(await backoffWithJitter(constantDelay(0.5), 0.5, 0.1)(10, new Error())).toBeTruthy();
    elapsed = new Date().getTime() - start;

    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1000);

    try {
        await backoffWithJitter(constantDelay(0.5), 0.5, 0.3);
        fail();
    } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((<Error>err).message).toContain("jitter should be [0, 0.25]");
    }

})

test("retry", async () => {
    // Happy path, works on first try.
    let fn = (): void => { };
    expect(await retry(fn, limit(3))).toBeUndefined();
   
    // Test eventual success
    let i = 0;
    fn = () => {  
        i++;
        if (i < 2) {
            throw new AccountDoesNotExist("");
        } 
    };
    expect(await retry(fn, limit(3))).toBeUndefined();
    
    // Ensure multiple strategies are evaluated.
    let called = 0;
    fn = () => { 
        called++;
        throw new AccountDoesNotExist("");
    };

    // For some reason, `expectThrowError()` doesn't properly handle errors.
    await retry(fn, limit(3), nonRetriableErrors(new AccountDoesNotExist("")))
        .then(_ => {
            fail();
        })
        .catch(err => {
            expect(err).toBe(err);
        });
    expect(called).toBe(1);
})

test("retry_async", async () => {
    const fn = (): Promise<number> => {
        return new Promise<number>(resolve => {
            setTimeout(resolve, 500, 1);
        })
    }
    const start = new Date().getTime();
    expect(await retryAsync(fn)).toBe(1);
    const duration = new Date().getTime() - start;
    expect(duration).toBeGreaterThanOrEqual(500);
    expect(duration).toBeLessThan(1000);
})
