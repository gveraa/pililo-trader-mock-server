const { describe, it, expect, beforeEach, afterEach, vi } = require('vitest');
const WebSocket = require('ws');
const { createTestServer } = require('../helpers/server.js');

describe('WebSocket Mock Integration Tests', () => {
  let testServer;
  let wsUrl;

  beforeEach(async () => {
    testServer = await createTestServer();
    wsUrl = testServer.wsUrl;
  });

  afterEach(async () => {
    if (testServer) {
      await testServer.close();
    }
  });

  describe('Connection Management', () => {
    it('should establish WebSocket connection', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        ws.on('open', () => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          resolve();
        });

        ws.on('error', reject);

        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });
    });

    it('should send welcome message on connection', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());

          expect(message).toMatchObject({
            type: 'welcome',
            message: 'Connected to test server',
            connectionId: expect.any(String)
          });

          resolve();
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Welcome message timeout')), 2000);
      });
    });

    it('should handle connection closure gracefully', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
        });

        ws.on('close', (code, reason) => {
          expect(code).toBe(1005); // Normal closure
          resolve();
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Close timeout')), 2000);
      });
    });
  });

  describe('Message Handling', () => {
    it('should echo messages containing "echo"', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        let welcomeReceived = false;

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());

          if (message.type === 'welcome') {
            welcomeReceived = true;
            // Send echo test message
            ws.send('echo test message');
            return;
          }

          if (welcomeReceived && message.type === 'echo') {
            expect(message).toMatchObject({
              type: 'echo',
              originalMessage: 'echo test message',
              timestamp: expect.any(String)
            });
            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Echo test timeout')), 3000);
      });
    });

    it('should respond to ping with pong', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        let welcomeReceived = false;

        ws.on('message', (data) => {
          const rawMessage = data.toString();

          // Handle welcome message (JSON)
          if (rawMessage.startsWith('{')) {
            const message = JSON.parse(rawMessage);
            if (message.type === 'welcome') {
              welcomeReceived = true;
              ws.send('ping');
              return;
            }
          }

          // Handle pong response (plain text)
          if (welcomeReceived && rawMessage === 'pong') {
            expect(rawMessage).toBe('pong');
            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Ping-pong test timeout')), 3000);
      });
    });

    it('should handle JSON path matching', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        let welcomeReceived = false;

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());

          if (message.type === 'welcome') {
            welcomeReceived = true;
            // Send subscription message
            ws.send(JSON.stringify({
              action: 'subscribe',
              channel: 'test-channel'
            }));
            return;
          }

          if (welcomeReceived && message.type === 'subscription_confirmed') {
            expect(message).toMatchObject({
              type: 'subscription_confirmed',
              channel: 'test-channel',
              timestamp: expect.any(String)
            });
            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('JSONPath test timeout')), 3000);
      });
    });

    it('should handle regex pattern matching', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        let welcomeReceived = false;

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());

          if (message.type === 'welcome') {
            welcomeReceived = true;
            // Send command message
            ws.send('command:restart');
            return;
          }

          if (welcomeReceived && message.type === 'command_response') {
            expect(message).toMatchObject({
              type: 'command_response',
              command: 'restart',
              result: 'executed'
            });
            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Regex test timeout')), 3000);
      });
    });
  });

  describe('Scheduled Messages', () => {
    it('should receive scheduled heartbeat messages', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        let welcomeReceived = false;
        let heartbeatReceived = false;

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());

          if (message.type === 'welcome') {
            welcomeReceived = true;
            return;
          }

          if (welcomeReceived && message.type === 'heartbeat' && !heartbeatReceived) {
            heartbeatReceived = true;
            expect(message).toMatchObject({
              type: 'heartbeat',
              timestamp: expect.any(String)
            });
            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Heartbeat timeout')), 7000);
      });
    }, 10000);

    it('should receive scheduled data feed messages', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        let welcomeReceived = false;
        let dataReceived = false;

        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());

          if (message.type === 'welcome') {
            welcomeReceived = true;
            return;
          }

          if (welcomeReceived && message.type === 'data' && !dataReceived) {
            dataReceived = true;
            expect(message).toMatchObject({
              type: 'data',
              value: expect.any(String),
              timestamp: expect.any(String)
            });

            // Verify value is within expected range
            const value = parseInt(message.value);
            expect(value).toBeGreaterThanOrEqual(1);
            expect(value).toBeLessThanOrEqual(100);

            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('Data feed timeout')), 3000);
      });
    }, 5000);
  });

  describe('Multiple Connections', () => {
    it('should handle multiple concurrent connections', async () => {
      const connections = [];
      const promises = [];

      for (let i = 0; i < 3; i++) {
        const ws = new WebSocket(`${wsUrl}/ws`);
        global.trackConnection(ws);
        connections.push(ws);

        const promise = new Promise((resolve, reject) => {
          ws.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'welcome') {
              expect(message.connectionId).toBeDefined();
              resolve(message.connectionId);
            }
          });

          ws.on('error', reject);
          setTimeout(() => reject(new Error(`Connection ${i} timeout`)), 3000);
        });

        promises.push(promise);
      }

      const connectionIds = await Promise.all(promises);

      // Verify all connections have unique IDs
      const uniqueIds = new Set(connectionIds);
      expect(uniqueIds.size).toBe(3);
    });

    it('should broadcast scheduled messages to all connections', async () => {
      const numConnections = 2;
      const connections = [];
      const heartbeatPromises = [];

      // Create multiple connections
      for (let i = 0; i < numConnections; i++) {
        const ws = new WebSocket(`${wsUrl}/ws`);
        global.trackConnection(ws);
        connections.push(ws);

        const promise = new Promise((resolve, reject) => {
          let welcomeReceived = false;

          ws.on('message', (data) => {
            const message = JSON.parse(data.toString());

            if (message.type === 'welcome') {
              welcomeReceived = true;
              return;
            }

            if (welcomeReceived && message.type === 'heartbeat') {
              resolve();
            }
          });

          ws.on('error', reject);
          setTimeout(() => reject(new Error(`Heartbeat timeout for connection ${i}`)), 7000);
        });

        heartbeatPromises.push(promise);
      }

      // Wait for all connections to receive heartbeat
      await Promise.all(heartbeatPromises);
    }, 10000);
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON messages gracefully', async () => {
      const ws = new WebSocket(`${wsUrl}/ws`);
      global.trackConnection(ws);

      return new Promise((resolve, reject) => {
        let welcomeReceived = false;
        let errorHandled = false;

        ws.on('message', (data) => {
          const rawMessage = data.toString();

          if (rawMessage.startsWith('{')) {
            const message = JSON.parse(rawMessage);
            if (message.type === 'welcome') {
              welcomeReceived = true;
              // Send invalid JSON
              ws.send('invalid json {');

              // Give some time for error handling, then resolve
              setTimeout(() => {
                if (!errorHandled) {
                  errorHandled = true;
                  resolve();
                }
              }, 1000);
              return;
            }
          }
        });

        ws.on('error', (error) => {
          // Connection errors are acceptable in this test
          if (!errorHandled) {
            errorHandled = true;
            resolve();
          }
        });

        setTimeout(() => {
          if (!errorHandled) {
            reject(new Error('Error handling timeout'));
          }
        }, 3000);
      });
    });
  });
});