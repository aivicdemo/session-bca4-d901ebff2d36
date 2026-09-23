import { APIGatewayProxyEvent } from 'aws-lambda';

export type Role = 'admin' | 'operator' | 'viewer';

export interface AuthContext {
  userId: string;
  role: Role;
  username: string;
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
  'GET /reminder-settings': ['admin', 'operator', 'viewer'],
  'GET /reminder-settings/{id}': ['admin', 'operator', 'viewer'],
  'POST /reminder-settings': ['admin', 'operator'],
  'PUT /reminder-settings/{id}': ['admin', 'operator'],
  'DELETE /reminder-settings/{id}': ['admin'],
  'POST /api/reminder-settings/bulk': ['admin', 'operator'],
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
  'POST /api/email-history/bulk': ['admin', 'operator']
};

export function extractAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const authHeader = event.headers['Authorization'] || '';
  const [, token] = authHeader.split(' ');
  
  if (!token) {
    throw new Error('Missing authorization token');
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    return {
      userId: decoded.userId,
      role: decoded.role as Role,
      username: decoded.username
    };
  } catch (error) {
    throw new Error('Invalid authorization token');
  }
}

export function checkPermission(method: string, path: string, role: Role): boolean {
  const endpoint = `${method} ${path}`;
  const allowedRoles = rbacPolicies[endpoint];
  
  if (!allowedRoles) {
    return false;
  }
  
  return allowedRoles.includes(role);
}

export function authorizeRequest(event: APIGatewayProxyEvent, requiredRoles: Role[]): AuthContext {
  const authContext = extractAuthContext(event);
  
  if (!requiredRoles.includes(authContext.role)) {
    throw new Error('Insufficient permissions');
  }
  
  return authContext;
}