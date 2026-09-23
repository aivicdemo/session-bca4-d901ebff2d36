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
  'POST /api/users/bulk': ['admin', 'operator'],
  'POST /api/reports/bulk': ['admin', 'operator'],
  'POST /api/reminders/bulk': ['admin', 'operator'],
  'POST /api/detection-logs/bulk': ['admin', 'operator'],
  'POST /api/email-history/bulk': ['admin', 'operator'],
  'GET /api/users': ['admin', 'operator'],
  'GET /api/users/:id': ['admin', 'operator'],
  'POST /api/users': ['admin'],
  'PUT /api/users/:id': ['admin', 'operator'],
  'DELETE /api/users/:id': ['admin'],
  'GET /api/reports': ['admin', 'operator', 'viewer'],
  'GET /api/reports/:id': ['admin', 'operator', 'viewer'],
  'POST /api/reports': ['admin', 'operator', 'viewer'],
  'PUT /api/reports/:id': ['admin', 'operator', 'viewer'],
  'DELETE /api/reports/:id': ['admin', 'operator'],
  'GET /api/reminders': ['admin', 'operator'],
  'GET /api/reminders/:id': ['admin', 'operator'],
  'POST /api/reminders': ['admin', 'operator'],
  'PUT /api/reminders/:id': ['admin', 'operator'],
  'DELETE /api/reminders/:id': ['admin'],
  'GET /api/detection-logs': ['admin', 'operator'],
  'GET /api/detection-logs/:id': ['admin', 'operator'],
  'POST /api/detection-logs': ['admin', 'operator'],
  'PUT /api/detection-logs/:id': ['admin', 'operator'],
  'DELETE /api/detection-logs/:id': ['admin'],
  'GET /api/email-history': ['admin', 'operator'],
  'GET /api/email-history/:id': ['admin', 'operator'],
  'POST /api/email-history': ['admin', 'operator'],
  'PUT /api/email-history/:id': ['admin', 'operator'],
  'DELETE /api/email-history/:id': ['admin']
};

export function extractAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const authHeader = event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    return {
      userId: decoded.userId || 'unknown',
      role: (decoded.role || 'viewer') as Role,
      username: decoded.username || 'unknown'
    };
  } catch {
    return {
      userId: 'unknown',
      role: 'viewer',
      username: 'unknown'
    };
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

export function createForbiddenResponse(): { statusCode: number; body: string } {
  return {
    statusCode: 403,
    body: JSON.stringify({ error: 'Forbidden: insufficient permissions' })
  };
}