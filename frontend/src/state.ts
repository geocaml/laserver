type Listener<T> = (val: T) => void;

function makeSignal<T>(initial: T) {
    let value = initial;
    const listeners = new Set<Listener<T>>();

    return {
        get: () => value,
        set: (update: T) => {
            value = update;
            listeners.forEach(l => {l(value)});
        },
        subscribe: (listener: Listener<T>) => {
            listeners.add(listener);
            return () => {listeners.delete(listener)};
        }
    }
}

export const debugMode = makeSignal(false);
