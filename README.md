# Mock Server

Configuration-driven mock server supporting WebSocket and REST APIs on port 8080.

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Configuration](#configuration)
  - [WebSocket Mocks](#websocket-mocks)
  - [API Mocks](#api-mocks)
  - [X-Mock-Scenario Header](#x-mock-scenario-header)
- [API Reference](#api-reference)
- [Development](#development)

## Quick Start

```bash
# Install
yarn install

# Run
yarn start

# Development mode
yarn dev

# Validate configs
yarn validate
```

### Docker

```bash
docker build -t mock-server .
docker run -v $(pwd)/mocks:/app/mocks -p 8080:8080 mock-server
```

## Features

- **Single server** on port 8080 for both WebSocket and REST
- **Configuration-driven** - JSON files define all behavior
- **Priority-based routing** - Exact paths > patterns > wildcards
- **Scenario testing** - Use X-Mock-Scenario header for different responses
- **Template variables** - Dynamic timestamps, random values, request data
- **Hot reload** - Auto-reload on config changes (dev mode)

## Configuration

Place JSON files in `mocks/` directory. Each file must specify `type: "ws"` or `type: "api"`.

### WebSocket Mocks

```json
{
  "name": "crypto-ws",
  "type": "ws",
  "description": "Crypto price feed",
  "scheduledMessages": [{
    "id": "btc-price",
    "interval": 5000,
    "message": {
      "symbol": "BTC/USD",
      "price": "{{random.number(40000,50000)}}",
      "timestamp": "{{timestamp}}"
    }
  }],
  "responseRules": [{
    "id": "echo",
    "matcher": {
      "type": "contains",
      "value": "ping"
    },
    "response": {
      "message": { "type": "pong" }
    }
  }]
}
```

### API Mocks

```json
{
  "name": "trading-api",
  "type": "api",
  "description": "Trading endpoints",
  "mappings": [{
    "id": "get-balance",
    "request": {
      "method": "GET",
      "urlPath": "/api/balance"
    },
    "response": {
      "status": 200,
      "jsonBody": {
        "BTC": "0.5",
        "USD": "25000"
      }
    }
  }]
}
```

### X-Mock-Scenario Header

Use dynamic patterns to test different scenarios without changing configuration:

```json
{
  "request": {
    "method": "GET",
    "urlPath": "/api/data",
    "headers": {
      "X-Mock-Scenario": {
        "matches": "error-\\d{3}"
      }
    }
  },
  "response": {
    "status": 200,
    "jsonBody": { "data": "Success" }
  }
}
```

**Dynamic patterns:**
- `timeout-[seconds]` - Simulates a timeout by delaying N seconds then returning 408 Request Timeout (e.g., `timeout-5` for 5s timeout, max 60s)
- `slow-[milliseconds]` - Delays response by N milliseconds with normal status (e.g., `slow-2000` for 2s delay, max 60000ms)
- `error-[code]` - Returns specified HTTP error code 400-599 (e.g., `error-404`, `error-503`)

**Examples:**
```bash
# Simulate 3 second timeout (returns 408 after 3s)
curl -H "X-Mock-Scenario: timeout-3" http://localhost:8080/api/test

# Slow response - 1.5 second delay (returns 200 after 1.5s)
curl -H "X-Mock-Scenario: slow-1500" http://localhost:8080/api/test

# Return 404 Not Found immediately
curl -H "X-Mock-Scenario: error-404" http://localhost:8080/api/test

# Return 503 Service Unavailable immediately
curl -H "X-Mock-Scenario: error-503" http://localhost:8080/api/test
```

## API Reference

### Built-in Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /status` | Show loaded mocks and failures |
| `GET /schema/ws` | WebSocket mock schema |
| `GET /schema/api` | API mock schema |
| `GET /status/:code` | Return any HTTP status |
| `GET /timeout/:seconds` | Delay response |

### WebSocket

- **Endpoint**: `ws://localhost:8080/ws`
- **Scheduled messages**: Auto-sent on intervals
- **Response rules**: Match incoming messages and respond
- **Matchers**: `exact`, `contains`, `regex`, `jsonPath`

### REST API

- **Path matching priority**:
  1. Exact paths (`urlPath`)
  2. Patterns (`urlPathPattern`)
  3. Wildcards (`.*`)
- **Request matching**: Method, path, headers, query, body
- **Response options**: Status, headers, body, delay

### Template Variables

| Variable | Description |
|----------|-------------|
| `{{timestamp}}` | ISO timestamp |
| `{{random.number(min,max)}}` | Random number |
| `{{random.uuid}}` | Random UUID |
| `{{request.field}}` | Request data |

## Development

```bash
# Project structure
mocks/                  # Configuration files
├── websocket/         # WebSocket mocks
├── api/               # API mocks
└── scenarios/         # Scenario-based mocks

src/                   # Source code
├── MockServer.js      # Main server class
├── modules/           # Core modules
└── index.js          # Entry point

schema/               # JSON schemas
├── mock-base-schema.json
├── websocket-mock-schema.json
└── api-mock-schema.json
```

### Commands

```bash
yarn dev              # Development with auto-reload
yarn validate         # Validate all configs
yarn validate:watch   # Watch mode validation
```

### Environment Variables

- `MOCKS_DIR` - Mock files directory (default: `mocks`)
- `NODE_ENV` - Environment (development/production)

### Creating Mocks

1. Create JSON file in `mocks/`
2. Set `type: "ws"` or `type: "api"`
3. Define behavior (messages/rules for WS, mappings for API)
4. Run `yarn validate` to check
5. Server auto-reloads in dev mode

### Priority System

API paths are matched by priority:
- **Priority 1**: Exact paths
- **Priority 100+**: Patterns (fewer wildcards = higher priority)
- **Priority 1000**: Catch-all wildcards

Example:
```
/api/users/123    (exact)    → Priority 1
/api/users/\d+    (pattern)  → Priority ~107
/api/.*           (wildcard) → Priority ~200
```