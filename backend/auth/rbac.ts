import { APIGatewayProxyEvent } from 'aws-lambda';

export type Role = 'admin' | 'operator' | 'viewer';

export interface AuthContext {
  userId: string;
  role: Role;
  userName: string;
}

export interface RBACPolicy {
  [endpoint: string]: Role[];
}

const rbacPolicies: RBACPolicy = {
  'GET /resources': ['admin', 'operator', 'viewer'],
  'GET /users': ['admin', 'operator', 'viewer'],
  'GET /users/{id}': ['admin', 'operator', 'viewer'],
  'POST /users': ['admin'],
  'PUT /users/{id}': ['admin'],
  'DELETE /users/{id}': ['admin'],
  'POST /api/users/bulk': ['admin', 'operator'],
  'GET /daily-reports': ['admin', 'operator', 'viewer'],
  'GET /daily-reports/{id}': ['admin', 'operator', 'viewer'],
  'POST /daily-reports': ['admin', 'operator', 'viewer'],
  'PUT /daily-reports/{id}': ['admin', 'operator', 'viewer'],
  'DELETE /daily-reports/{id}': ['admin', 'operator'],
  'POST /api/daily-reports/bulk': ['admin', 'operator'],
  'GET /reminders': ['admin', 'operator', 'viewer'],
  'GET /reminders/{id}': ['admin', 'operator', 'viewer'],
  'POST /reminders': ['admin', 'operator'],
  'PUT /reminders/{id}': ['admin', 'operator'],
  'DELETE /reminders/{id}': ['admin'],
  'POST /api/reminders/bulk': ['admin', 'operator'],
  'GET /detection-logs': ['admin', 'operator'],
  'GET /detection-logs/{id}': ['admin', 'operator'],
  'POST /detection-logs': ['admin', 'operator'],
  'PUT /detection-logs/{id}': ['admin', 'operator'],
  'DELETE /detection-logs/{id}': ['admin'],
  'POST /api/detection-logs/bulk': ['admin', 'operator'],
  'GET /email-history': ['admin', 'operator'],
  'GET /email-history/{id}': ['admin', 'operator'],
  'POST /email-history': ['admin', 'operator'],
  'PUT /email-history/{id}': ['admin', 'operator'],
  'DELETE /email-history/{id}': ['admin'],
  'POST /api/email-history/bulk': ['admin', 'operator'],
};

export function extractAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const authHeader = event.headers['Authorization'] || '';
  const match = authHeader.match(/Bearer\s+(.+)/);
  const token = match ? match[1] : '';
  
  // Mock token parsing - in production, verify JWT
  const decoded = Buffer.from(token, 'base64').toString('utf-8');
  const [userId, role, userName] = decoded.split(':');
  
  return {
    userId: userId || 'unknown',
    role: (role as Role) || 'viewer',
    userName: userName || 'unknown',
  };
}

export function checkPermission(method: string, path: string, role: Role): boolean {
  const endpoint = `${method} ${path}`;
  const allowedRoles = rbacPolicies[endpoint];
  
  if (!allowedRoles) {
    return false;
  }
  
  return allowedRoles.includes(role);
}

export function createUnauthorizedResponse() {
  return {
    statusCode: 403,
    body: JSON.stringify({ error: 'Forbidden', message: 'Insufficient permissions' }),
  };
}

export function createBadRequestResponse(message: string) {
  return {
    statusCode: 400,
    body: JSON.stringify({ error: 'Bad Request', message }),
  };
}

export function createNotFoundResponse(message: string) {
  return {
    statusCode: 404,
    body: JSON.stringify({ error: 'Not Found', message }),
  };
}

export function createInternalErrorResponse(message: string) {
  return {
    statusCode: 500,
    body: JSON.stringify({ error: 'Internal Server Error', message }),
  };
}

export function createSuccessResponse(data: unknown, statusCode: number = 200) {
  return {
    statusCode,
    body: JSON.stringify(data),
  };
}