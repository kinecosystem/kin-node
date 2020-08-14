export async function retry<T>(fn: () => T, ...strategies: ShouldRetry[]): Promise<T> {
    return await retryAsync((): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            try {
                resolve(fn());
            } catch (err) {
                reject(err);
            }
        })
    }, ...strategies);
}

export async function retryAsync<T>(fn: () => Promise<T>, ...strategies: ShouldRetry[]): Promise<T> {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (err) {
            for (const s of strategies) {
                if (!await s(i, err)) {
                    return Promise.reject(err);
                }
            }
        }
    }
}

export type ShouldRetry = (attempt: number, err: Error) => Promise<boolean>;

export function limit(maxAttempts: number): ShouldRetry {
    return (attempt: number, _: Error): Promise<boolean> => {
        return Promise.resolve(attempt < maxAttempts);
    }
}

export function retriableErrors(...errors: any[]): ShouldRetry {
    return (_: number, err: Error): Promise<boolean> => {
        for (const allowed of errors) {
            if (err instanceof allowed) {
                return Promise.resolve(true);
            }
        }

        return Promise.resolve(false);
    }
}

export function nonRetriableErrors(...errors: any[]): ShouldRetry {
    return (_: number, err: Error): Promise<boolean> => {
        for (const disallowed of errors) {
            if (err instanceof disallowed) {
                return Promise.resolve(false);
            }
        }

        return Promise.resolve(true);
    }
}

export function backoff(fn: DelayFunction, maxDelaySeconds: number): ShouldRetry {
    return async (attempt: number, _: Error): Promise<boolean> => {
        const delay = Math.min(fn(attempt), maxDelaySeconds);

        return new Promise(resolve => setTimeout(resolve, delay * 1000))
            .then(() => true);
    }
}

export function backoffWithJitter(fn: DelayFunction, maxDelaySeconds: number, jitter: number): ShouldRetry {
    if (jitter < 0.0 || jitter >= 0.25) {
        throw new Error("jitter should be [0, 0.25]");
    }

    return async (attempt: number, _: Error): Promise<boolean> => {
        const delay = Math.min(fn(attempt), maxDelaySeconds);

        // Center the jitter around the capped delay:
        //     <------cappedDelay------>
        //      jitter           jitter
        const delayWithJitter = delay * (1 + Math.random() * jitter*2 - jitter);
        return new Promise(resolve => setTimeout(resolve, delayWithJitter * 1000))
            .then(() => true);
    }
}

export type DelayFunction = (attempts: number) => number

export function constantDelay(seconds: number): DelayFunction {
    return (_: number): number => {
        return seconds;
    }
}

export function linearDelay(baseDelaySeconds: number): DelayFunction {
    return (attempts: number): number => {
        return baseDelaySeconds * attempts;
    }
}

export function expontentialDelay(baseDelaySeconds: number, base: number): DelayFunction {
    return (attempts: number): number => {
        return baseDelaySeconds * Math.pow(base, attempts-1);
    }
}

export function binaryExpotentialDelay(baseDelaySeconds: number): DelayFunction {
    return expontentialDelay(baseDelaySeconds, 2);
}
