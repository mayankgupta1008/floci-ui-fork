import type {Connect, Plugin} from 'vite'
import {defineConfig, loadEnv} from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

export default defineConfig(({mode}) => {
    const env = loadEnv(mode, process.cwd(), '')
    const flociTarget = env.VITE_FLOCI_BASE_URL || 'http://localhost:4566'
    const isHttps = flociTarget.startsWith('https://')
    const withoutProtocol = flociTarget.replace(/^https?:\/\//, '')
    const [hostPart, portPart] = withoutProtocol.split(':')
    const hostname = hostPart || 'localhost'
    const port = portPart ? Number(portPart) : (isHttps ? 443 : 4566)

    const flociProxyPlugin: Plugin = {
        name: 'floci-proxy',
        configureServer(server) {
            server.middlewares.use((req: Connect.IncomingMessage, res: http.ServerResponse, next: Connect.NextFunction) => {
                if (!req.url?.startsWith('/floci-proxy')) return next()

                const targetPath = req.url.replace(/^\/floci-proxy/, '') || '/'
                const transport = isHttps ? https : http
                const chunks: Buffer[] = []

                req.on('data', (chunk: Buffer) => chunks.push(chunk))
                req.on('end', () => {
                    const body = Buffer.concat(chunks)
                    const headers: Record<string, string> = {}
                    const keep = ['content-type', 'accept', 'authorization', 'x-amz-target', 'x-amz-date', 'x-amz-security-token', 'range']

                    for (const key of keep) {
                        const value = req.headers[key]
                        if (typeof value === 'string') headers[key] = value
                    }
                    if (body.length > 0) headers['content-length'] = String(body.length)

                    const proxy = transport.request(
                        {hostname, port, path: targetPath, method: req.method, headers, agent: false},
                        (proxyRes) => {
                            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
                            proxyRes.pipe(res)
                        }
                    )

                    proxy.on('error', (err) => {
                        res.writeHead(502)
                        res.end(`Floci unreachable: ${err.message}`)
                    })

                    if (body.length > 0) proxy.write(body)
                    proxy.end()
                })
            })
        },
    }

    return {
        plugins: [react(), flociProxyPlugin],
        resolve: {
            alias: {'@': path.resolve(__dirname, './src')},
        },
        build: {
            rollupOptions: {
                output: {
                    manualChunks: {
                        'react-vendor': ['react', 'react-dom', 'react-router-dom'],
                        'query-vendor': ['@tanstack/react-query', '@tanstack/react-query-devtools'],
                        'ui-vendor': ['lucide-react'],
                    },
                },
            },
        },
        server: {port: 3000},
    }
})
