# Pililo Trader Mock Server

A configuration-driven mock server that supports both WebSocket and REST API mocking. It merges multiple JSON configurations into a single server running on port 8080 for testing trading platforms, real-time data feeds, and API endpoints.

## Table of Contents

- [Quick Start](#quick-start)
  - [Install and Run](#1-install-and-run)
  - [Available Endpoints](#2-available-endpoints)
  - [Docker](#3-docker)
  - [Docker Compose](#4-docker-compose)
- [Configuration Schema](#configuration-schema)
  - [Directory Structure](#directory-structure-flexible)
  - [Basic Configuration](#basic-configuration)
  - [Schema File Location](#schema-file-location)
  - [Sample JSON Files](#sample-json-files)
  - [Schema Fields](#schema-fields)
  - [Scheduled Messages](#scheduled-messages)
  - [Response Rules](#response-rules)
  - [Template Variables](#template-variables)
- [How It Works](#how-it-works)
  - [Configuration Loading](#1-configuration-loading)
  - [ID Prefixing](#2-id-prefixing)
  - [Message Flow](#3-message-flow)
  - [Example Client](#4-example-client)
- [Development](#development)
- [Configuration Validation](#configuration-validation)
- [License](#license)

## Quick Start

### 1. Install and Run

```bash
# Install dependencies
yarn install

# Start the server
yarn start
```

The server starts on **port 8080** at `ws://localhost:8080/ws`

### 2. Available Endpoints

- **WebSocket**: `ws://localhost:8080/ws`
- **Health Check**: `http://localhost:8080/health`
- **Status**: `http://localhost:8080/status` - Shows all loaded mock configurations
- **Schema Endpoints**:
  - `http://localhost:8080/schema/ws` - Returns the complete WebSocket mock JSON schema with base fields (name, type, description)
  - `http://localhost:8080/schema/api` - Returns the complete API mock JSON schema with base fields (name, type, description)
- **Test Endpoints**:
  - `http://localhost:8080/status/[code]` - Returns any HTTP status code (100-599)
  - `http://localhost:8080/timeout/[seconds]` - Delays response by specified seconds (0-60)

### 3. Docker

```bash
# Build the image
docker build -t mock-server .

# Run with volume mount for configurations
docker run -v $(pwd)/mocks:/app/mocks -p 8080:8080 mock-server

# Run in detached mode
docker run -d -v $(pwd)/mocks:/app/mocks -p 8080:8080 --name mock-server mock-server

# View logs
docker logs mock-server

# Stop the container
docker stop mock-server
```

### 4. Docker Compose

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  mock-server:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./mocks:/app/mocks
    environment:
      - NODE_ENV=production
      - MOCKS_DIR=mocks
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

Run with docker-compose:

```bash
# Start the service
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the service
docker-compose down
```

## Configuration Schema

Create JSON files either directly in `mocks/` or organized in subdirectories. All configurations are automatically merged. Each configuration must specify a `type` field: either `"ws"` for WebSocket or `"api"` for REST API mocking.

### Directory Structure (Flexible)

```
mocks/
├── example-websocket.json      # WebSocket mock config
├── example-api.json            # API mock config
├── trading/                    # Subdirectories (optional)
│   ├── ws-orders.json          # WebSocket configs
│   └── api-orders.json         # API configs
├── ripio/
│   └── api-endpoints.json      # API endpoints
└── market-data/
    └── ws-prices.json          # WebSocket configs
```

### Basic Configuration

#### WebSocket Configuration

```json
{
  "name": "my-websocket-mock",
  "type": "ws",
  "description": "WebSocket mock configuration",
  "scheduledMessages": [
    {
      "id": "price-update",
      "interval": 1000,
      "enabled": true,
      "startDelay": 500,
      "message": {
        "type": "price",
        "symbol": "BTC/USD",
        "price": "{{random.number(40000,50000)}}",
        "timestamp": "{{timestamp}}"
      }
    }
  ],
  "responseRules": [
    {
      "id": "subscribe-response",
      "enabled": true,
      "matcher": {
        "type": "jsonPath",
        "path": "$.action",
        "value": "subscribe"
      },
      "response": {
        "delay": 100,
        "message": {
          "status": "subscribed",
          "channel": "{{request.channel}}"
        }
      }
    }
  ]
}
```

#### API Configuration

```json
{
  "name": "my-api-mock",
  "type": "api",
  "description": "API mock configuration",
  "mappings": [
    {
      "id": "get-ticker",
      "request": {
        "method": "GET",
        "urlPath": "/api/ticker"
      },
      "response": {
        "status": 200,
        "headers": {
          "Content-Type": "application/json"
        },
        "jsonBody": {
          "price": 50000,
          "timestamp": "{{timestamp}}"
        }
      }
    }
  ]
}
```

### Schema File Locations

The JSON schemas that validate configurations are located at:
- **Base Schema**: `schema/mock-base-schema.json` - Defines common fields and type selection
- **WebSocket Schema**: `schema/websocket-mock-schema.json` - WebSocket-specific configuration
- **API Schema**: `schema/api-mock-schema.json` - API-specific configuration
- **Usage**: Automatically used during server startup and validation commands

### Sample JSON Files

The repository includes several example configurations:

**Root Level Example:**
- **File**: `mocks/simple-example.json`
- **Contains**: Basic heartbeat and echo functionality

**Organized Examples:**
- **Trading**: `mocks/trading/example-trading-server.json`
  - Ticker updates, order simulation, balance updates
  - Multiple response rules for trading operations
- **News**: `mocks/news/crypto-news-server.json`
  - Breaking news alerts, market analysis
  - News subscription/unsubscription handling  
- **Market Data**: `mocks/market-data/market-data-server.json`
  - Price feeds, orderbook data, market summaries
  - Real-time market data simulation

You can use these as templates for creating your own configurations.

### Common Schema Fields

**Required:**
- `name` (string): Unique identifier for the configuration
- `type` (string): Either "ws" or "api"

**Optional:**
- `description` (string): Human-readable description

### WebSocket-Specific Fields

- `scheduledMessages` (array): Auto-sent messages on intervals
- `responseRules` (array): Rules for responding to incoming messages
- `connectionBehavior` (object): Connection handling settings

### API-Specific Fields

- `mappings` (array): Request/response mapping definitions

### Scheduled Messages

```json
{
  "id": "unique-id",
  "interval": 1000,           // milliseconds (min: 100)
  "enabled": true,            // boolean
  "startDelay": 0,           // initial delay (ms)
  "message": { /* payload */ }
}
```

### WebSocket Response Rules

```json
{
  "id": "unique-id",
  "enabled": true,
  "matcher": {
    "type": "exact|contains|regex|jsonPath",
    "value": "value-to-match",
    "path": "$.field"         // only for jsonPath
  },
  "response": {
    "delay": 0,               // response delay (ms)
    "multiple": false,        // allow multiple matches
    "message": { /* payload */ }
  }
}
```

### API Mappings

```json
{
  "id": "unique-id",
  "enabled": true,
  "request": {
    "method": "GET|POST|PUT|DELETE|PATCH",
    "urlPath": "/exact/path",
    "urlPathPattern": "/regex/([A-Z]+)",  // alternative to urlPath
    "headers": {
      "Header-Name": {
        "equals": "exact-value",
        "matches": "regex-pattern"
      }
    },
    "queryParameters": {
      "param": {
        "equals": "value",
        "matches": "pattern"
      }
    },
    "bodyPatterns": [
      {
        "contains": "substring",
        "matches": "regex",
        "equalToJson": { /* exact JSON */ },
        "matchesJsonPath": {
          "expression": "$.field",
          "equals": "value"
        }
      }
    ]
  },
  "response": {
    "status": 200,
    "delay": 0,
    "headers": {
      "Content-Type": "application/json"
    },
    "body": "string body",
    "jsonBody": { /* JSON response */ },
    "base64Body": "base64 encoded content"
  }
}
```

### Template Variables

Use these in any message payload:

- `{{timestamp}}` - Current ISO timestamp
- `{{random.number(min,max)}}` - Random number in range
- `{{random.uuid}}` - Random UUID
- `{{request.fieldName}}` - Value from incoming request
- `{{date.now}}` - Timestamp in milliseconds

## How It Works

### 1. Configuration Loading

The server scans `mocks/` folder and all subdirectories, merging configurations by type:

```
✓ Loaded valid WebSocket configuration: example-websocket
✓ Loaded valid API configuration: example-api
✓ Loaded valid API configuration: ripio-endpoints
✓ Created merged WebSocket configuration
  - Total: 5 scheduled messages, 8 response rules
✓ Created merged API configuration
  - Total: 15 mappings
🚀 Mock server started on port 8080
```

### 2. ID Prefixing

To prevent conflicts, IDs are automatically prefixed based on location:

- Root files: `root-configname-originalid`
- Subdirectory files: `subdirectory-configname-originalid`

Examples:
- `simple-config.json` → `root-simple-config-price-update`
- `trading/orders.json` → `trading-orders-price-update`

### 3. Message Flow

1. **Scheduled Messages**: Sent automatically based on intervals
2. **Incoming Messages**: Matched against response rules
3. **Template Processing**: Variables replaced with dynamic values
4. **Response Sent**: After configured delay

### 4. Example Clients

#### WebSocket Client

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

ws.on('open', () => {
  // Subscribe to a channel
  ws.send(JSON.stringify({
    action: 'subscribe',
    channel: 'BTC/USD'
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  console.log('Received:', message);
});
```

#### API Client

```javascript
// GET request
fetch('http://localhost:8080/api/ticker')
  .then(res => res.json())
  .then(data => console.log('Ticker:', data));

// POST request with auth
fetch('http://localhost:8080/api/order', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-token'
  },
  body: JSON.stringify({
    symbol: 'BTC_USD',
    amount: 0.1,
    price: 50000
  })
})
  .then(res => res.json())
  .then(data => console.log('Order:', data));
```

## Development

```bash
# Install dependencies
yarn install

# Run with auto-reload
yarn dev

# Validate configurations
yarn validate

# Watch and validate on changes
yarn validate:watch
```

## Configuration Validation

The server validates all configurations on startup:

- JSON schema compliance based on type (ws/api)
- Unique configuration names within subdirectories
- Unique rule/message/mapping IDs within each config
- JSONPath expression syntax
- API mappings must have either urlPath or urlPathPattern
- Valid HTTP methods and status codes

## Status Endpoint

The `/status` endpoint returns all loaded mock configurations organized by subdirectory/filename, including any failed configurations:

```json
{
  "ws": {
    "example-websocket": [
      "scheduled:heartbeat@5000ms",
      "rule:echo[contains:echo]"
    ],
    "trading/ws-orders": [
      "scheduled:price-update@1000ms",
      "scheduled:balance@3000ms",
      "rule:subscribe[jsonPath:$.action=subscribe]",
      "rule:unsubscribe[jsonPath:$.action=unsubscribe]",
      "rule:order[contains:{\"type\":\"order\"}]"
    ],
    "failed": {
      "invalid-ws-config": [
        "/scheduledMessages/0: must have required property 'id'",
        "Duplicate response rule IDs found: rule-1"
      ]
    }
  },
  "api": {
    "_built-in": [
      "GET /health",
      "GET /status",
      "GET /status/:code",
      "GET /timeout/:seconds",
      "GET /schema/ws",
      "GET /schema/api"
    ],
    "example-api": [
      "GET /api/ticker",
      "GET /api/ticker/:param",
      "POST /api/order"
    ],
    "ripio/ripio-trade-errors": [
      "GET /ripio/ticker",
      "GET /ripio/ticker/([A-Z]+_[A-Z]+)",
      "GET /ripio/pairs"
    ],
    "failed": {
      "broken-api-config": [
        "Failed to load file: Unexpected token } in JSON at position 125",
        "/mappings/0/request: must have required property 'urlPath'"
      ]
    }
  }
}
```

Notes:
- **`_built-in`**: Lists all built-in API endpoints provided by the mock server
- **`failed`**: Appears only when there are validation errors and contains:
  - **Key**: The file path (subdirectory/filename format, or just filename for root files)
  - **Value**: Array of validation error messages explaining why the configuration failed

## License

MIT