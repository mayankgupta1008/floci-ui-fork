import {FlociError} from './types'

export const PROXY = '/floci-proxy'
export const IS_MOCK_MODE = import.meta.env.VITE_MOCK_MODE === 'true'
export const FLOCI_BASE_URL = import.meta.env.VITE_FLOCI_BASE_URL || 'http://localhost:4566'

export interface FlociRequestEvent {
    service: string
    method: string
    path: string
    target?: string
    action?: string
    statusCode: number
    latencyMs: number
    timestamp: number
}

const listeners = new Set<(event: FlociRequestEvent) => void>()

export function subscribeRequests(cb: (event: FlociRequestEvent) => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
}

function emitRequest(event: FlociRequestEvent) {
    for (const listener of listeners) {
        try {
            listener(event)
        } catch {
            // listeners should not affect AWS calls
        }
    }
}

interface RequestOptions {
    method?: string
    body?: string
    signal?: AbortSignal
    headers?: Record<string, string>
    service?: string
    action?: string
}

async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
    const started = performance.now()
    let statusCode = 0

    try {
        const response = await fetch(`${PROXY}${path}`, {
            method: opts.method ?? 'GET',
            signal: opts.signal,
            headers: opts.headers,
            body: opts.body,
        }).catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : 'Network error'
            throw new FlociError(`Cannot reach Floci: ${message}`, undefined, path)
        })

        statusCode = response.status
        if (!response.ok) throw new FlociError(`HTTP ${response.status}`, response.status, path)
        return response
    } finally {
        if (statusCode > 0) {
            emitRequest({
                service: opts.service ?? 'unknown',
                method: opts.method ?? 'GET',
                path,
                target: opts.headers?.['X-Amz-Target'],
                action: opts.action,
                statusCode,
                latencyMs: Math.round(performance.now() - started),
                timestamp: Date.now(),
            })
        }
    }
}

export async function flociGetXml(path: string, signal?: AbortSignal): Promise<string> {
    const res = await request(path, {signal, headers: {Accept: 'application/xml'}, service: 's3'})
    return res.text()
}

export async function flociGetJson<T>(path: string, service: string, signal?: AbortSignal): Promise<T> {
    const res = await request(path, {signal, headers: {Accept: 'application/json'}, service})
    return res.json() as Promise<T>
}

export async function flociRestJson<T>(path: string, service: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await request(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        headers: {
            Accept: 'application/json',
            ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        },
        service,
    })
    return res.json() as Promise<T>
}

export async function flociQueryAction(params: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const action = params.Action ?? ''
    const service = action.toLowerCase().includes('queue') ? 'sqs' : action.toLowerCase().includes('topic') ? 'sns' : 'query'
    const res = await request('/', {
        method: 'POST',
        body: new URLSearchParams(params).toString(),
        signal,
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/xml'},
        service,
        action,
    })
    return res.text()
}

export async function flociJsonAction<T>(target: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const service = target.startsWith('Logs_20140328.') || target.startsWith('GraniteServiceVersion20100801.')
        ? 'cloudwatch'
        : target.startsWith('DynamoDB_20120810.')
            ? 'dynamodb'
            : 'json'
    const contentType = target.startsWith('DynamoDB_20120810.') || target.startsWith('GraniteServiceVersion20100801.')
        ? 'application/x-amz-json-1.0'
        : 'application/x-amz-json-1.1'
    const res = await request('/', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
        headers: {
            'Content-Type': contentType,
            'X-Amz-Target': target,
            Accept: 'application/json',
        },
        service,
        action: target.split('.').pop(),
    })
    return res.json() as Promise<T>
}
