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
  'GET /daily-reports': ['admin', 'operator', 'viewer'],
  'GET /daily-reports/{id}': ['admin', 'operator', 'viewer'],
  'POST /daily-reports': ['admin', 'operator'],
  'PUT /daily-reports/{id}': ['admin', 'operator'],
  'DELETE /daily-reports/{id}': ['admin'],
  'GET /reminder-settings': ['admin', 'operator', 'viewer'],
  'GET /reminder-settings/{id}': ['admin', 'operator', 'viewer'],
  'POST /reminder-settings': ['admin', 'operator'],
  'PUT /reminder-settings/{id}': ['admin', 'operator'],
  'DELETE /reminder-settings/{id}': ['admin'],
  'GET /detection-logs': ['admin', 'operator'],
  'GET /detection-logs/{id}': ['admin', 'operator'],
  'POST /detection-logs': ['admin', 'operator'],
  'PUT /detection-logs/{id}': ['admin', 'operator'],
  'DELETE /detection-logs/{id}': ['admin'],
  'GET /email-history': ['admin', 'operator'],
  'GET /email-history/{id}': ['admin', 'operator'],
  'POST /email-history': ['admin', 'operator'],
  'PUT /email-history/{id}': ['admin', 'operator'],
  'DELETE /email-history/{id}': ['admin'],
  'POST /api/0/bulk': ['admin', 'operator'],
  'POST /api/1/bulk': ['admin', 'operator'],
  'POST /api/2/bulk': ['admin', 'operator'],
  'POST /api/3/bulk': ['admin', 'operator'],
  'POST /api/4/bulk': ['admin', 'operator']
};

export function checkPermission(endpoint: string, role: Role): boolean {
  const allowedRoles = rbacPolicies[endpoint];
  if (!allowedRoles) {
    return false;
  }
  return allowedRoles.includes(role);
}

export function extractAuthContext(event: APIGatewayProxyEvent): AuthContext | null {
  const authHeader = event.headers['Authorization'] || event.headers['authorization'];
  if (!authHeader) {
    return null;
  }

  try {
    const token = authHeader.replace('Bearer ', '');
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    return {
      userId: decoded.userId,
      role: decoded.role as Role,
      username: decoded.username
    };
  } catch (error) {
    return null;
  }
}

export function createAuthToken(userId: string, role: Role, username: string): string {
  const payload = { userId, role, username };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}