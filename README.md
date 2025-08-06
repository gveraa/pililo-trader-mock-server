# Mock Server

Configuration-driven mock server supporting WebSocket and REST APIs on port 8080.

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [How to create mocks?](#how-to-create-mocks)
  - [WebSocket](#websocket)
    - [Matchers](#matchers)
      - [Exact Match](#exact-match)
      - [Contains Match](#contains-match)
      - [Regex Match](#regex-match)
      - [JSONPath Match](#jsonpath-match)
  - [REST API](#rest-api)
    - [Request Matching Rules](#request-matching-rules)
      - [Method Matching](#method-matching)
      - [URL Path Matching](#url-path-matching)
      - [Header Matching](#header-matching)
      - [Query Parameter Matching](#query-parameter-matching)
      - [Body Matching](#body-matching)
      - [Complete Example](#complete-example)
      - [Matching Order](#matching-order)
  - [X-Mock-Scenario Header](#x-mock-scenario-header)
    - [Scenario Restrictions](#scenario-restrictions)
    - [Performance & Network Scenarios](#performance--network-scenarios)
    - [Authentication Scenarios](#authentication-scenarios)
    - [Data Response Scenarios](#data-response-scenarios)
    - [HTTP Error Scenarios](#http-error-scenarios)
    - [Combined Scenarios](#combined-scenarios)
  - [Template Variables](#template-variables)
- [API Reference](#api-reference)
  - [Built-in Endpoints](#built-in-endpoints)
- [Development](#development)
  - [Mock Examples](#mock-examples)
  - [Commands](#commands)
  - [Environment Variables](#environment-variables)
  - [Priority System](#priority-system)
  - [Diagnostic Logging](#diagnostic-logging)

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
- **Diagnostic logging** - Comprehensive request/response logging with correlation IDs

## How to create mocks?

1. Create JSON file in `mocks/`
2. Set `type: "ws"` or `type: "api"`
3. Define behavior (messages/rules for WS, mappings for API)
4. Run `yarn validate` to check
5. Server auto-reloads in dev mode

### WebSocket

- **Endpoint**: `ws://localhost:8080/ws`
- **Scheduled messages**: Auto-sent on intervals
- **Response rules**: Match incoming messages and respond
- **Matchers**: `exact`, `contains`, `regex`, `jsonPath`

**Example configuration:**
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

#### Matchers

WebSocket response rules use matchers to determine when to send responses based on incoming messages.

##### Exact Match
Matches the entire message exactly:
```json
{
  "matcher": {
    "type": "exact",
    "value": "get-balance"
  }
}
```

##### Contains Match
Matches if the message contains the specified substring:
```json
{
  "matcher": {
    "type": "contains",
    "value": "subscribe"
  }
}
```

##### Regex Match
Matches using regular expressions:
```json
{
  "matcher": {
    "type": "regex",
    "value": "^(buy|sell)\\s+\\d+\\s+\\w+$"
  }
}
```

##### JSONPath Match
Matches based on JSONPath expressions in JSON messages:
```json
{
  "matcher": {
    "type": "jsonPath",
    "path": "$.action",
    "value": "subscribe"
  }
}
```

### REST API

- **Path matching priority**:
  1. Exact paths (`urlPath`)
  2. Patterns (`urlPathPattern`)
  3. Wildcards (`.*`)
- **Request matching**: Method, path, headers, query, body
- **Response options**: Status, headers, body, delay

**Example configuration:**
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

#### Request Matching Rules

The mock server evaluates requests against configured mappings using multiple criteria. ALL conditions must match for a mapping to be selected.

##### **Method Matching**
```json
"request": {
  "method": "POST"  // GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
}
```
- Case-insensitive exact match
- Defaults to "GET" if not specified
- Use "ANY" to match any method

##### **URL Path Matching**

**Exact Path** (Priority 1):
```json
"urlPath": "/api/users/profile"  // Must match exactly
```

**Pattern Path** (Priority 100+):
```json
"urlPathPattern": "/api/users/\\d+"  // Regex pattern
```
- Standard regex syntax
- Escape special characters (`\\d` for `\d`)
- Priority based on pattern complexity

##### **Header Matching**

**Exact Match**:
```json
"headers": {
  "Content-Type": "application/json",  // Short form
  "Accept": {
    "equals": "application/json"      // Long form
  }
}
```

**Pattern Match**:
```json
"headers": {
  "Authorization": {
    "matches": "Bearer [A-Za-z0-9-_]+"  // Regex
  }
}
```

**Contains**:
```json
"headers": {
  "User-Agent": {
    "contains": "Mozilla"  // Substring
  }
}
```

**Absent Check**:
```json
"headers": {
  "X-Debug": {
    "absent": true  // Must NOT exist
  }
}
```

##### **Query Parameter Matching**

```json
"queryParameters": {
  "limit": {
    "equals": "10"                    // Exact match
  },
  "page": {
    "matches": "\\d+"                 // Regex pattern
  }
}
```

##### **Body Matching**

**Contains**:
```json
"bodyPatterns": [{
  "contains": "search_term"           // Substring in body
}]
```

**JSON Match**:
```json
"bodyPatterns": [{
  "equalToJson": {
    "username": "john"                // Exact JSON match
  }
}]
```

**JSON Path**:
```json
"bodyPatterns": [{
  "matchesJsonPath": "$.items[?(@.price > 100)]"  // JSONPath query
}]
```

##### **Complete Example**

```json
{
  "mappings": [{
    "id": "create-order",
    "request": {
      "method": "POST",
      "urlPath": "/api/orders",
      "headers": {
        "Content-Type": {
          "equals": "application/json"
        },
        "Authorization": {
          "matches": "Bearer .+"
        }
      },
      "queryParameters": {
        "priority": {
          "equals": "high"
        }
      },
      "bodyPatterns": [{
        "matchesJsonPath": "$.items[*].quantity"
      }]
    },
    "response": {
      "status": 201,
      "headers": {
        "Location": "/api/orders/12345"
      },
      "jsonBody": {
        "orderId": "12345",
        "status": "created"
      }
    }
  }]
}
```

##### **Matching Order**

1. **Method Check** - HTTP method must match
2. **Path Check** - URL path must match (exact or pattern)
3. **Headers Check** - ALL header conditions must pass
4. **Query Check** - ALL query parameter conditions must pass
5. **Body Check** - ALL body patterns must match

If any check fails, the mapping is skipped and the next one is evaluated.

### X-Mock-Scenario Header

Use dynamic patterns to test different scenarios without changing configuration. The X-Mock-Scenario header allows you to simulate various conditions including network issues, authentication problems, data quality issues, and HTTP errors.

### Scenario Restrictions

API mocks can restrict which scenarios they accept using `allowedScenarios` or `forbiddenScenarios` (but not both):

```json
{
  "mappings": [{
    "id": "payment-endpoint",
    "request": {
      "method": "POST",
      "urlPath": "/api/payment"
    },
    "response": {
      "status": 200,
      "jsonBody": { "success": true }
    },
    "allowedScenarios": [
      "slow-response-[ms]",
      "error-409-conflict",
      "error-500-internal"
    ]
  }]
}
```

**Configuration Options:**
- `allowedScenarios`: Array of allowed scenario patterns (whitelist)
- `forbiddenScenarios`: Array of forbidden scenario patterns (blacklist)
- If neither is specified, all scenarios are allowed
- Cannot use both in the same mapping (validation will fail)

**Pattern Placeholders:**
- `[ms]` - Milliseconds value
- `[percent]` - Percentage value (0-100)
- `[field-name]` - Any field name
- `[header-name]` - Any header name
- `[code]` - HTTP status code

### Performance & Network Scenarios

#### Response Delays
**Pattern:** `slow-response-[ms]` where `[ms]` is any millisecond value  
**Purpose:** Test how your application handles slow API responses and loading states
```bash
curl -H "X-Mock-Scenario: slow-response-3000" http://localhost:8080/api/balance
```
*Simulates a 3-second delay (3000ms) before returning the response. Useful for testing loading spinners, timeout handling, and user experience during slow network conditions. Examples: slow-response-500, slow-response-1500, slow-response-10000*

#### Timeouts
**Pattern:** `request-timeout-after-[ms]` where `[ms]` is any millisecond value  
**Purpose:** Test application behavior when requests exceed timeout limits
```bash
curl -H "X-Mock-Scenario: request-timeout-after-5000" http://localhost:8080/api/trade
```
*Request will timeout after 5 seconds (5000ms) and return a 408 Request Timeout error. Tests timeout handling, retry logic, and error recovery mechanisms. Examples: request-timeout-after-1000, request-timeout-after-30000, request-timeout-after-60000*

#### Network Issues
**Purpose:** Simulate various network connectivity problems

```bash
curl -H "X-Mock-Scenario: connection-reset" http://localhost:8080/api/data
```
*Simulates TCP connection reset by peer. Tests network resilience and connection error handling.*

```bash
curl -H "X-Mock-Scenario: connection-refused" http://localhost:8080/api/health
```
*Simulates connection refused error. Tests behavior when service is unavailable or port is blocked.*

```bash
curl -H "X-Mock-Scenario: network-unreachable" http://localhost:8080/api/status
```
*Simulates network unreachable condition. Tests handling of network routing issues.*

```bash
curl -H "X-Mock-Scenario: dns-resolution-failure" http://localhost:8080/api/ping
```
*Simulates DNS lookup failure. Tests behavior when hostname cannot be resolved.*

### Authentication Scenarios

#### Valid Authentication
**Purpose:** Test successful authentication flows and authorized access

```bash
curl -H "Authorization: Bearer valid-token" -H "X-Mock-Scenario: valid-auth-bearer" http://localhost:8080/api/profile
```
*Generic valid Bearer token authentication. Tests successful JWT/Bearer token flow.*

```bash
curl -u "username:password" -H "X-Mock-Scenario: valid-auth-basic" http://localhost:8080/api/data
```
*Valid HTTP Basic authentication. Tests traditional username/password auth flow.*

```bash
curl -H "X-API-Key: test123" -H "X-Mock-Scenario: valid-auth-apikey-x-api-key" http://localhost:8080/api/balance
```
*Valid API key in X-API-Key header. Tests API key authentication - checks if header exists, any value is considered valid. Pattern: valid-auth-apikey-[header] where [header] is the header name (e.g., valid-auth-apikey-authorization-token, valid-auth-apikey-client-key)*

```bash
curl -H "X-Mock-Scenario: valid-auth-jwt" http://localhost:8080/api/user
```
*Valid JWT token authentication. Tests JSON Web Token validation and claims.*

```bash
curl -H "X-Mock-Scenario: valid-auth-oauth2" http://localhost:8080/api/me
```
*Valid OAuth2 access token. Tests OAuth2 flow and token-based authorization.*

#### Invalid Authentication
**Purpose:** Test security handling of invalid credentials and malformed auth data

```bash
curl -H "Authorization: Bearer invalid" -H "X-Mock-Scenario: invalid-auth-bearer" http://localhost:8080/api/secure
```
*Invalid Bearer token format or value. Tests rejection of bad tokens and security error handling.*

```bash
curl -H "X-Mock-Scenario: invalid-auth-bearer-expired" http://localhost:8080/api/profile
```
*Expired Bearer token. Tests token expiration handling and refresh token flows.*

```bash
curl -H "X-Mock-Scenario: invalid-auth-bearer-malformed" http://localhost:8080/api/data
```
*Malformed Bearer token header. Tests parsing of badly formatted authorization headers.*

```bash
curl -u "wrong:credentials" -H "X-Mock-Scenario: invalid-auth-basic" http://localhost:8080/api/secure
```
*Invalid Basic auth credentials. Tests rejection of wrong username/password combinations.*

```bash
curl -H "X-Mock-Scenario: invalid-auth-basic-format" http://localhost:8080/api/login
```
*Malformed Basic auth header format. Tests handling of improperly encoded Basic auth.*

```bash
curl -H "X-API-Key: invalid" -H "X-Mock-Scenario: invalid-auth-apikey-x-api-key" http://localhost:8080/api/balance
```
*Invalid API key value. Tests API key validation - header exists but key is invalid. Pattern: invalid-auth-apikey-[header] where [header] is the header name (e.g., invalid-auth-apikey-authorization-token, invalid-auth-apikey-client-secret)*

```bash
curl -H "X-Mock-Scenario: invalid-auth-jwt" http://localhost:8080/api/user
```
*Invalid JWT signature or claims. Tests JWT validation and signature verification.*

```bash
curl -H "X-Mock-Scenario: invalid-auth-jwt-expired" http://localhost:8080/api/profile
```
*Expired JWT token. Tests JWT expiration handling and token refresh scenarios.*

```bash
curl -H "X-Mock-Scenario: invalid-auth-oauth2" http://localhost:8080/api/me
```
*Invalid OAuth2 access token. Tests OAuth2 token validation and error responses.*

#### Missing Authentication
**Purpose:** Test behavior when required authentication is completely absent

```bash
curl -H "X-Mock-Scenario: missing-auth-bearer" http://localhost:8080/api/secure
```
*No Authorization header provided. Tests enforcement of Bearer token requirements.*

```bash
curl -H "X-Mock-Scenario: missing-auth-basic" http://localhost:8080/api/protected
```
*No Basic auth credentials provided. Tests Basic auth requirement enforcement.*

```bash
curl -H "X-Mock-Scenario: missing-auth-apikey-x-api-key" http://localhost:8080/api/balance
```
*No X-API-Key header provided. Tests API key requirement enforcement - header is completely missing. Pattern: missing-auth-apikey-[header] where [header] is the required header name (e.g., missing-auth-apikey-authorization-token, missing-auth-apikey-app-key)*

```bash
curl -H "X-Mock-Scenario: missing-auth-jwt" http://localhost:8080/api/user
```
*No JWT token provided. Tests JWT requirement enforcement and unauthorized access handling.*

```bash
curl -H "X-Mock-Scenario: missing-auth-oauth2" http://localhost:8080/api/profile
```
*No OAuth2 token provided. Tests OAuth2 requirement enforcement.*

### Data Response Scenarios

#### Partial Data
**Pattern:** `partial-data-[percent]` where `[percent]` is any percentage value (0-100)  
**Purpose:** Test handling of incomplete data responses and pagination

```bash
curl -H "X-Mock-Scenario: partial-data-50" http://localhost:8080/api/transactions
```
*Returns only 50% of expected data. Tests UI handling of partial results, infinite scroll behavior, and data loading states. Examples: partial-data-25, partial-data-75, partial-data-90*

#### Data Quality Issues
**Purpose:** Test robustness against various data integrity problems

```bash
curl -H "X-Mock-Scenario: data-missing-field-id" http://localhost:8080/api/users
```
*Response missing required 'id' field. Tests handling of incomplete data structures and field validation. Pattern: data-missing-field-[field] where [field] is any field name (e.g., data-missing-field-email, data-missing-field-timestamp)*

```bash
curl -H "X-Mock-Scenario: data-null-field-balance" http://localhost:8080/api/account
```
*Balance field returned as null. Tests null value handling and default value logic. Pattern: data-null-field-[field] where [field] is any field name (e.g., data-null-field-price, data-null-field-status)*

```bash
curl -H "X-Mock-Scenario: data-wrong-type-field-price" http://localhost:8080/api/products
```
*Price field has wrong data type (e.g., string instead of number). Tests type validation and conversion. Pattern: data-wrong-type-field-[field] where [field] is any field name (e.g., data-wrong-type-field-count, data-wrong-type-field-date)*

```bash
curl -H "X-Mock-Scenario: data-corrupted-json" http://localhost:8080/api/data
```
*Returns malformed JSON response. Tests JSON parsing error handling and graceful degradation.*

```bash
curl -H "X-Mock-Scenario: data-extra-fields" http://localhost:8080/api/clean
```
*Response contains unexpected extra fields. Tests handling of API schema changes and forward compatibility.*

```bash
curl -H "X-Mock-Scenario: data-truncated-80" http://localhost:8080/api/report
```
*Response cut off at 80% completion. Tests handling of incomplete responses and data corruption. Pattern: data-truncated-[percent] where [percent] is any percentage (e.g., data-truncated-50, data-truncated-90)*

### HTTP Error Scenarios

#### Client Errors (4xx)
**Purpose:** Test handling of client-side errors and user input validation

```bash
curl -H "X-Mock-Scenario: error-400-bad-request" http://localhost:8080/api/submit
```
*Returns 400 Bad Request. Tests handling of malformed requests and input validation errors.*

```bash
curl -H "X-Mock-Scenario: error-401-unauthorized" http://localhost:8080/api/secure
```
*Returns 401 Unauthorized. Tests authentication requirement enforcement and login redirects.*

```bash
curl -H "X-Mock-Scenario: error-403-forbidden" http://localhost:8080/api/admin
```
*Returns 403 Forbidden. Tests authorization and permission denied scenarios.*

```bash
curl -H "X-Mock-Scenario: error-404-not-found" http://localhost:8080/api/nonexistent
```
*Returns 404 Not Found. Tests handling of missing resources and broken links.*

```bash
curl -H "X-Mock-Scenario: error-405-method-not-allowed" http://localhost:8080/api/readonly
```
*Returns 405 Method Not Allowed. Tests HTTP method validation and REST API compliance.*

```bash
curl -H "X-Mock-Scenario: error-409-conflict" http://localhost:8080/api/create
```
*Returns 409 Conflict. Tests handling of resource conflicts and duplicate creation attempts.*

```bash
curl -H "X-Mock-Scenario: error-422-validation-failed" http://localhost:8080/api/validate
```
*Returns 422 Unprocessable Entity. Tests business logic validation and detailed error messages.*

```bash
curl -H "X-Mock-Scenario: error-429-too-many-requests" http://localhost:8080/api/limited
```
*Returns 429 Too Many Requests. Tests rate limiting enforcement and backoff strategies.*

#### Server Errors (5xx)
**Purpose:** Test handling of server-side failures and service degradation

```bash
curl -H "X-Mock-Scenario: error-500-internal" http://localhost:8080/api/process
```
*Returns 500 Internal Server Error. Tests handling of unexpected server failures and error recovery.*

```bash
curl -H "X-Mock-Scenario: error-502-bad-gateway" http://localhost:8080/api/proxy
```
*Returns 502 Bad Gateway. Tests handling of upstream service failures and proxy errors.*

```bash
curl -H "X-Mock-Scenario: error-503-service-unavailable" http://localhost:8080/api/maintenance
```
*Returns 503 Service Unavailable. Tests maintenance mode handling and service degradation.*

```bash
curl -H "X-Mock-Scenario: error-504-gateway-timeout" http://localhost:8080/api/slow-backend
```
*Returns 504 Gateway Timeout. Tests handling of upstream timeout and cascading failures.*

```bash
curl -H "X-Mock-Scenario: error-507-insufficient-storage" http://localhost:8080/api/upload
```
*Returns 507 Insufficient Storage. Tests handling of resource exhaustion and capacity limits.*

#### Combined Scenarios

##### Multiple Scenarios
**Purpose:** Test complex real-world conditions where multiple issues occur simultaneously. Combine scenarios with commas to simulate realistic production issues.

##### 1. Slow Network with Partial Data Loss
```bash
curl -H "X-Mock-Scenario: slow-response-2000,partial-data-50,data-missing-field-timestamp" http://localhost:8080/api/transactions
```
*Simulates degraded network conditions where responses are slow (2s delay), only half the data arrives, and critical timestamp fields are missing. Tests resilience against poor connectivity and data integrity issues.*

##### 2. Authentication Failure Under Load
```bash
curl -H "Authorization: Bearer expired-token" -H "X-Mock-Scenario: invalid-auth-bearer-expired,slow-response-3000,error-429-too-many-requests" http://localhost:8080/api/secure
```
*Tests how the application handles expired tokens when the server is under heavy load (rate limiting active) with slow responses. Common scenario during traffic spikes.*

##### 3. Database Issues with Field Corruption
```bash
curl -H "X-Mock-Scenario: slow-response-5000,data-null-field-id,data-wrong-type-field-price,data-extra-fields" http://localhost:8080/api/products
```
*Simulates database performance issues (5s delay) with data quality problems: null IDs, wrong data types for prices, and unexpected fields. Tests handling of degraded database conditions.*

##### 4. API Gateway Timeout with Truncated Response
```bash
curl -H "X-Mock-Scenario: request-timeout-after-30000,data-truncated-80,error-504-gateway-timeout" http://localhost:8080/api/report
```
*Simulates an API gateway timing out after 30 seconds with incomplete data transmission. Tests timeout handling and partial response recovery strategies.*

##### 5. Cascading Service Failures
```bash
curl -H "X-Mock-Scenario: error-503-service-unavailable,slow-response-8000,connection-reset" http://localhost:8080/api/health
```
*Simulates a service trying to recover from maintenance mode but experiencing network instability. Tests circuit breaker patterns and failover mechanisms.*

##### 6. Valid Auth with Data Quality Issues
```bash
curl -H "X-API-Key: valid-key-123" -H "X-Mock-Scenario: valid-auth-apikey-x-api-key,partial-data-25,data-corrupted-json" http://localhost:8080/api/dashboard
```
*Authenticated request succeeds but receives severely degraded data (only 25% complete and corrupted JSON). Tests graceful degradation when authentication works but backend systems fail.*

##### 7. Mobile App Poor Connectivity Simulation
```bash
curl -H "X-Mock-Scenario: slow-response-4000,partial-data-60,connection-reset,request-timeout-after-10000" http://localhost:8080/api/mobile/sync
```
*Simulates typical mobile connectivity issues: slow 4G/weak WiFi (4s delays), partial data transmission (60%), intermittent connection drops, and eventual timeout. Essential for mobile app testing.*

##### 8. Payment Processing Edge Cases
```bash
curl -H "Authorization: Bearer valid-token" -H "X-Mock-Scenario: valid-auth-bearer,slow-response-6000,error-409-conflict,data-missing-field-transaction_id" http://localhost:8080/api/payment/process
```
*Tests payment processing under adverse conditions: valid authentication but slow processing (6s), conflict errors (duplicate payment attempts), and missing transaction IDs. Critical for financial transaction testing.*

##### 9. Microservices Communication Breakdown
```bash
curl -H "X-Mock-Scenario: error-502-bad-gateway,dns-resolution-failure,slow-response-2500,data-null-field-status" http://localhost:8080/api/orders/status
```
*Simulates inter-service communication failures: bad gateway errors, DNS issues between services, slow responses, and null status fields. Tests microservices resilience patterns.*

##### 10. Rate Limited API with Authentication Issues
```bash
curl -H "X-API-Key: invalid" -H "X-Mock-Scenario: invalid-auth-apikey-x-api-key,error-429-too-many-requests,slow-response-1000" http://localhost:8080/api/search
```
*Combines invalid API key with rate limiting and slow responses. Common scenario when bots or scrapers hit APIs with bad credentials repeatedly.*

### Template Variables

| Variable | Description |
|----------|-------------|
| `{{timestamp}}` | ISO timestamp |
| `{{random.number(min,max)}}` | Random number |
| `{{random.uuid}}` | Random UUID |
| `{{request.field}}` | Request data |

## API Reference

### Built-in Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | API documentation - Shows all available endpoints |
| `GET /health` | Health check - Server status and connections |
| `GET /status` | Show loaded mocks, scenarios, and failures |
| `GET /schema/ws` | WebSocket mock schema |
| `GET /schema/api` | API mock schema |
| `GET /status/:code` | Return any HTTP status (100-599) |
| `GET /timeout/:seconds` | Delay response (0-60 seconds) |

## Development

```bash
# Project structure
mocks/                              # Mock configuration files
├── api-examples/                   # REST API mock examples
│   ├── payment-api.json           # Payment processing with scenario restrictions
│   ├── user-management-api.json   # User CRUD operations with auth requirements
│   ├── health-monitoring-api.json # Health checks with forbidden scenarios
│   ├── trading-platform-api.json  # Trading endpoints (unrestricted)
│   └── ripio/                     # Ripio exchange mocks
│       └── ripio-trade-errors.json # Error scenarios for trading
└── websocket-examples/             # WebSocket mock examples
    ├── example-websocket.json     # Basic WebSocket with echo
    ├── market-data/               # Market data feeds
    │   └── market-data-server.json # Real-time price feeds
    ├── news/                      # News feed examples
    │   └── crypto-news-server.json # Crypto news broadcasts
    └── trading/                   # Trading WebSocket examples
        └── example-trading-server.json # Order updates & balances

src/                               # Source code
├── index.js                       # Application entry point
├── validate.js                    # Configuration validator
├── MockServer.js                  # Main server orchestrator
├── modules/                       # Core functionality modules
│   ├── ConfigurationManager.js   # Loads and validates mock configs
│   ├── ConnectionManager.js      # WebSocket connection management
│   ├── MessageHandler.js         # WebSocket message processing
│   ├── SchedulerService.js       # Scheduled message sender
│   ├── ApiRequestMatcher.js      # Legacy API request matcher
│   ├── FastApiRequestMatcher.js  # Optimized API request matcher
│   ├── ApiResponseHandler.js     # API response processor
│   ├── TemplateEngine.js         # Legacy template processor
│   ├── FastTemplateEngine.js     # Optimized template engine
│   ├── RequestLogger.js          # Diagnostic request logging
│   ├── MockMatcherDebugger.js    # Debug why requests match/fail
│   └── ScenarioValidator.js      # X-Mock-Scenario validation
└── utils/                         # Utility modules
    ├── logger.js                  # Pino logger configuration
    ├── fastLogger.js              # Performance logging utilities
    └── performanceOptimizer.js   # Server optimization helpers

schema/                            # JSON schema definitions
├── mock-base-schema.json         # Base schema for all mocks
├── api-mock-schema.json          # REST API mock schema
└── websocket-mock-schema.json    # WebSocket mock schema

logs/                              # Log files directory
├── .gitkeep                       # Ensures directory in git
└── mock-server.log               # Server logs (when ENABLE_FILE_LOGGING=true)
```

### Mock Examples

1. **payment-api.json** - Financial operations with `allowedScenarios` whitelist
2. **user-management-api.json** - User endpoints with different restrictions per endpoint
3. **health-monitoring-api.json** - System health endpoints using `forbiddenScenarios` blacklist
4. **trading-platform-api.json** - Trading endpoints with no restrictions (accepts all scenarios)

### Commands

```bash
yarn dev              # Development with auto-reload
yarn validate         # Validate all configs
yarn validate:watch   # Watch mode validation
```

### Environment Variables

- `MOCKS_DIR` - Mock files directory (default: `mocks`)
- `NODE_ENV` - Environment (development/production)
- `ENABLE_FILE_LOGGING` - Enable file logging to `./logs/mock-server.log` (default: `false`)
  - Set to `true` to enable file logging
  - Log file is overwritten on each startup (no rotation)
  - Includes comprehensive diagnostic information for troubleshooting

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

### Diagnostic Logging

The mock server includes comprehensive diagnostic logging to help troubleshoot test failures:

#### **Request Logger**
- Logs all incoming requests with correlation IDs
- Tracks matched mock configurations and response details  
- Records scenario processing and modifications applied
- Shows response timing and status codes

#### **Mock Matcher Debugger**
- Shows detailed analysis of why requests matched or didn't match specific mocks
- Includes priority evaluation and matching criteria breakdown
- Provides failure reasons with helpful suggestions
- Records performance metrics for the matching process

#### **Scenario Validator**  
- Validates X-Mock-Scenario header syntax
- Provides detailed error messages for invalid scenarios
- Suggests corrections for common mistakes

#### **Log Output Examples**

Console output (default):
```
[12:34:56 UTC] INFO: → [req-abc123] GET /api/users
[12:34:56 UTC] INFO: ✓ [req-abc123] Matched: user-api (priority: 1)
[12:34:56 UTC] INFO: ← [req-abc123] ✅ 200 (25ms)
```

When no match found:
```
[12:34:56 UTC] WARN: ❌ [req-xyz789] No match found (15 mappings tested, path most common failure)
```

Invalid scenario header:
```
[12:34:56 UTC] WARN: ❌ Invalid scenario header: slow-response-abc
    suggestions: ["Use format: slow-response-[milliseconds], e.g., slow-response-2000"]
```

#### **File Logging**

Enable file logging for persistent diagnostic information:

```bash
# Enable file logging
ENABLE_FILE_LOGGING=true yarn start

# Logs will be written to:
# ./logs/mock-server.log (current)
# ./logs/mock-server.log.1 (after rotation)
# ./logs/mock-server.log.2 (oldest)
```

File logs contain the same diagnostic information in JSON format for easier parsing and analysis.