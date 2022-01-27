/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EventEmitter } from 'vscode'
import { WebviewApi } from 'vscode-webview'
import { VueWebview, VueWebviewPanel, VueWebviewView } from './main'
import { Protocol } from './server'

declare const vscode: WebviewApi<any>

interface MessageBase<U extends string = string> {
    id: string
    command: U
}

export interface Message<T = any, U extends string = string> extends MessageBase<U> {
    data: T | Error
    event?: false
    error?: boolean
}

interface EventMessage<T = any, U extends string = string> extends MessageBase<U> {
    event: true
    data: T
    command: U
}

/**
 * Message used for delivering errors. The `data` field is a stringified `Error`.
 * Currently only `Error` instances are rebuilt, though it is possible to extend this.
 */
interface ErrorMessage<U extends string = string> extends MessageBase<U> {
    error: true
    data: string
    command: U
}

type ClientCommands<T> = {
    readonly [P in keyof T]: T[P] extends EventEmitter<infer P>
        ? (listener: (e: P) => void) => Promise<{ dispose: () => void }>
        : OmitThisParameter<T[P]> extends (...args: infer P) => infer R
        ? (...args: P) => R extends Promise<any> ? R : Promise<R>
        : never
}

export interface ClientQuery {
    readonly target?: string
}
export interface ClientStatus {
    readonly id?: string
    readonly name?: string
    readonly data: Record<string, any>
}

export interface GlobalProtocol extends Protocol {
    $inspect: EventEmitter<ClientQuery>
    $report: (status: ClientStatus) => void
    $clear: () => void
}

/** Can be created by {@link WebviewClientFactory} */
export type WebviewClient<T> = ClientCommands<T>

/** A narrowed form of `window` containing only the methods needed by the client */
type Window = Pick<typeof window, 'addEventListener' | 'removeEventListener' | 'clearTimeout' | 'dispatchEvent'>
type VscodeApi = typeof vscode

/**
 * Implements message sending/receiving for the frontend, keeping track of required state.
 */
export class WebviewClientAgent {
    /** All listeners (except the 'global' commands) registered to `message`. */
    private readonly _messageListeners: Set<() => any> = new Set()
    /** Resources that should be freed when the client is no longer needed. */
    private readonly _disposables: { dispose: () => void }[] = []

    public constructor(protected readonly window: Window, protected readonly vscode: VscodeApi) {
        // Explicitly check for its presence as `Event` is not available in Node
        if (globalThis.Event) {
            this.registerGlobalCommands()
        }
    }

    /**
     * Adds a new listener to the `message` event.
     */
    private addListener(listener: (...args: any) => void): void {
        this._messageListeners.add(listener)
        this.window.addEventListener('message', listener)
    }

    /**
     * Removes the listener from the backing store and unregisters it from the window.
     */
    private removeListener(listener: (...args: any) => void): void {
        this._messageListeners.delete(listener)
        this.window.removeEventListener('message', listener)
    }

    /**
     * Sets up 'global' commands used internally for special functionality that is otherwise
     * not exposed to the frontend or backend code. This is intended for persistent listeners
     * that are not directly tied to the application.
     */
    private registerGlobalCommands() {
        const remountEvent = new Event('remount')

        this.window.addEventListener('message', (event: { data: Message }) => {
            const { command } = event.data
            if (command === '$clear') {
                vscode.setState({})
                this._messageListeners.forEach(listener => this.removeListener(listener))
                this.window.dispatchEvent(remountEvent)
            }
        })
    }

    /**
     * Sends a request to the backend server. This effectively wraps a 'message' event into a Promise.
     * Registered listeners are automatically disposed of after receiving the desired message. Arguments
     * are 'de-proxied' and parsed into plain objects.
     *
     * If no response has been received after 5 minutes, the Promise is rejected and listener removed.
     *
     * @param id Message ID. Should be unique to each individual request.
     * @param command Identifier associated with the backend command.
     * @param args Arguments to pass to the backend command.
     * @param timeout How long to wait for a response from the backend.
     *
     * @returns The backend's response as a Promise.
     */
    public sendRequest<T extends any[], R, U extends string>(
        id: string,
        command: U,
        args: T,
        timeout = 300000
    ): Promise<R | { dispose: () => void }> {
        const deproxied = JSON.parse(JSON.stringify(args))
        const response = new Promise<R | { dispose: () => void }>((resolve, reject) => {
            const listener = (event: { data: Message<R, U> | ErrorMessage<U> }) => {
                const message = event.data

                if (id !== message.id) {
                    return
                }

                this.removeListener(listener)
                this.window.clearTimeout(timer)

                if (message.error === true) {
                    const revived = JSON.parse(message.data as string)
                    reject(new Error(revived.message))
                } else if (message.event) {
                    if (typeof args[0] !== 'function') {
                        reject(new Error(`Expected frontend event handler to be a function: ${command}`))
                    }
                    resolve(this.registerEventHandler(command, args[0]))
                } else {
                    resolve(message.data as R) // TODO: interfaces need a bit of refinement in terms of types
                }
            }

            const timer = setTimeout(() => {
                this.removeListener(listener)
                reject(new Error(`Timed out while waiting for response: id: ${id}, command: ${command}`))
            }, timeout)

            this.addListener(listener)
        })

        this.vscode.postMessage({ id, command, data: deproxied } as Message<T, U>)
        return response
    }

    private registerEventHandler<T extends (e: R) => void, R, U extends string>(
        command: U,
        args: T
    ): { dispose: () => void } {
        const listener = (event: { data: Message<R, U> | EventMessage<R, U> }) => {
            const message = event.data

            if (message.command !== command) {
                return
            }

            if (!message.event) {
                throw new Error(`Expected backend handler to be an event emitter: ${command}`)
            }

            args(message.data)
        }
        this.addListener(listener)

        return { dispose: () => this.removeListener(listener) }
    }

    public dispose(): void {
        // TODO: dispose of `_messageListeners`
        while (this._disposables.length) {
            this._disposables.shift()!.dispose()
        }
    }
}

/**
 * Used to create a new 'WebviewClient' to communicate with the backend.
 */
export class WebviewClientFactory {
    /** Used to generate unique ids per request/message. */
    private static _counter = 0 // Should initialize this with epoch time or something
    /** The 'agent' handles the communication protocol between client/server. */
    private static _agent: WebviewClientAgent

    /**
     * Creates a new client. These clients are defined by their types; they do not have any knowledge
     * of the backend protocol other than the specified type.
     */
    public static create<T extends VueWebview<any>>(): WebviewClient<T['protocol']>
    public static create<T extends VueWebviewPanel<any>>(): WebviewClient<T['protocol']>
    public static create<T extends VueWebviewView<any>>(): WebviewClient<T['protocol']>
    public static create<T extends Protocol<any, any>>(): WebviewClient<T>
    public static create<T extends Protocol<any, any>>(): WebviewClient<T> {
        const agent = (this._agent ??= new WebviewClientAgent(window, vscode))

        return new Proxy(
            {},
            {
                set: () => {
                    throw new TypeError('Cannot set property to webview client')
                },
                get: (_, prop) => {
                    if (typeof prop !== 'string') {
                        console.warn(`Tried to index webview client with non-string property: ${String(prop)}`)
                        return
                    }

                    if (prop === 'init') {
                        const state = vscode.getState() ?? {}
                        if (state['__once']) {
                            return () => Promise.resolve()
                        }
                        vscode.setState(Object.assign(state, { __once: true }))
                    }

                    const id = String(this._counter++)
                    return (...args: any) => agent.sendRequest(id, prop, args)
                },
                // Makes Vue happy, though it's still erroneous
                getPrototypeOf() {
                    return Object
                },
            }
        ) as WebviewClient<T>
    }
}
