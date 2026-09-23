import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { extractAuthContext, checkPermission, createForbiddenResponse, Role } from './rbac';

const client = new DynamoDBClient({ region: 'ap-northeast-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'daily-report-system';

interface AuditLog {
  pk: string;
  sk: string;
  action: string;
  userId: string;
  username: string;
  timestamp: number;
  details: Record<string, unknown>;
}

interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  department?: string;
  role: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

interface Report {
  id: string;
  userId: string;
  reportDate: number;
  content: string;
  achievements?: string;
  issues?: string;
  nextPlan?: string;
  createdAt: number;
  updatedAt: number;
}

interface ReminderSetting {
  id: string;
  userId: string;
  enabled: boolean;
  sendTime: string;
  sendDays?: string;
  sendMethod: string;
  createdAt: number;
  updatedAt: number;
}

interface DetectionLog {
  id: string;
  userId: string;
  targetDate: number;
  detectedAt: number;
  reminderSent: boolean;
  reminderSentAt?: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface EmailHistory {
  id: string;
  userId: string;
  emailType: string;
  toAddress: string;
  subject: string;
  body: string;
  sentAt: number;
  status: string;
  errorMessage?: string;
  relatedReportId?: string;
  relatedReminderId?: string;
  retryFlag: boolean;
  createdAt: number;
}

type TableType = 'users' | 'reports' | 'reminders' | 'detection-logs' | 'email-history';

const tableIndexMap: Record<string, TableType> = {
  '0': 'users',
  '1': 'reports',
  '2': 'reminders',
  '3': 'detection-logs',
  '4': 'email-history'
};

function getTableKey(tableType: TableType): string {
  return `${tableType}#`;
}

async function writeAuditLog(action: string, userId: string, username: string, details: Record<string, unknown>): Promise<void> {
  const auditLog: AuditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    action,
    userId,
    username,
    timestamp: Date.now(),
    details
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validateUser(user: Partial<User>): string[] {
  const errors: string[] = [];
  
  if (!user.username || user.username.length === 0) {
    errors.push('username is required');
  }
  if (!user.email || !validateEmail(user.email)) {
    errors.push('valid email is required');
  }
  if (!user.name || user.name.length === 0) {
    errors.push('name is required');
  }
  if (!user.role || !['admin', 'operator', 'viewer'].includes(user.role)) {
    errors.push('role must be admin, operator, or viewer');
  }
  if (!user.status || !['active', 'inactive', 'suspended'].includes(user.status)) {
    errors.push('status must be active, inactive, or suspended');
  }
  
  return errors;
}

function validateReport(report: Partial<Report>): string[] {
  const errors: string[] = [];
  
  if (!report.userId || report.userId.length === 0) {
    errors.push('userId is required');
  }
  if (!report.reportDate || report.reportDate === 0) {
    errors.push('reportDate is required');
  }
  if (!report.content || report.content.length === 0) {
    errors.push('content is required');
  }
  
  return errors;
}

function validateReminderSetting(reminder: Partial<ReminderSetting>): string[] {
  const errors: string[] = [];
  
  if (!reminder.userId || reminder.userId.length === 0) {
    errors.push('userId is required');
  }
  if (reminder.enabled === undefined) {
    errors.push('enabled is required');
  }
  if (!reminder.sendTime || !/^\d{2}:\d{2}$/.test(reminder.sendTime)) {
    errors.push('sendTime must be in HH:MM format');
  }
  if (!reminder.sendMethod || reminder.sendMethod.length === 0) {
    errors.push('sendMethod is required');
  }
  
  return errors;
}

function validateDetectionLog(log: Partial<DetectionLog>): string[] {
  const errors: string[] = [];
  
  if (!log.userId || log.userId.length === 0) {
    errors.push('userId is required');
  }
  if (!log.targetDate || log.targetDate === 0) {
    errors.push('targetDate is required');
  }
  if (log.reminderSent === undefined) {
    errors.push('reminderSent is required');
  }
  if (!log.status || !['unreported', 'reported', 'overdue'].includes(log.status)) {
    errors.push('status must be unreported, reported, or overdue');
  }
  
  return errors;
}

function validateEmailHistory(email: Partial<EmailHistory>): string[] {
  const errors: string[] = [];
  
  if (!email.userId || email.userId.length === 0) {
    errors.push('userId is required');
  }
  if (!email.emailType || email.emailType.length === 0) {
    errors.push('emailType is required');
  }
  if (!email.toAddress || !validateEmail(email.toAddress)) {
    errors.push('valid toAddress is required');
  }
  if (!email.subject || email.subject.length === 0) {
    errors.push('subject is required');
  }
  if (!email.body || email.body.length === 0) {
    errors.push('body is required');
  }
  if (!email.status || !['success', 'failed', 'pending'].includes(email.status)) {
    errors.push('status must be success, failed, or pending');
  }
  if (email.retryFlag === undefined) {
    errors.push('retryFlag is required');
  }
  
  return errors;
}

async function handleGetResources(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const resources = [
      { endpoint: 'GET /resources', description: 'Get available resources' },
      { endpoint: 'GET /api/users', description: 'List all users', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/users/:id', description: 'Get user by ID', roles: ['admin', 'operator'] },
      { endpoint: 'POST /api/users', description: 'Create new user', roles: ['admin'] },
      { endpoint: 'PUT /api/users/:id', description: 'Update user', roles: ['admin', 'operator'] },
      { endpoint: 'DELETE /api/users/:id', description: 'Delete user', roles: ['admin'] },
      { endpoint: 'POST /api/users/bulk', description: 'Bulk import users', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/reports', description: 'List all reports', roles: ['admin', 'operator', 'viewer'] },
      { endpoint: 'GET /api/reports/:id', description: 'Get report by ID', roles: ['admin', 'operator', 'viewer'] },
      { endpoint: 'POST /api/reports', description: 'Create new report', roles: ['admin', 'operator', 'viewer'] },
      { endpoint: 'PUT /api/reports/:id', description: 'Update report', roles: ['admin', 'operator', 'viewer'] },
      { endpoint: 'DELETE /api/reports/:id', description: 'Delete report', roles: ['admin', 'operator'] },
      { endpoint: 'POST /api/reports/bulk', description: 'Bulk import reports', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/reminders', description: 'List all reminder settings', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/reminders/:id', description: 'Get reminder setting by ID', roles: ['admin', 'operator'] },
      { endpoint: 'POST /api/reminders', description: 'Create new reminder setting', roles: ['admin', 'operator'] },
      { endpoint: 'PUT /api/reminders/:id', description: 'Update reminder setting', roles: ['admin', 'operator'] },
      { endpoint: 'DELETE /api/reminders/:id', description: 'Delete reminder setting', roles: ['admin'] },
      { endpoint: 'POST /api/reminders/bulk', description: 'Bulk import reminder settings', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/detection-logs', description: 'List all detection logs', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/detection-logs/:id', description: 'Get detection log by ID', roles: ['admin', 'operator'] },
      { endpoint: 'POST /api/detection-logs', description: 'Create new detection log', roles: ['admin', 'operator'] },
      { endpoint: 'PUT /api/detection-logs/:id', description: 'Update detection log', roles: ['admin', 'operator'] },
      { endpoint: 'DELETE /api/detection-logs/:id', description: 'Delete detection log', roles: ['admin'] },
      { endpoint: 'POST /api/detection-logs/bulk', description: 'Bulk import detection logs', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/email-history', description: 'List all email history', roles: ['admin', 'operator'] },
      { endpoint: 'GET /api/email-history/:id', description: 'Get email history by ID', roles: ['admin', 'operator'] },
      { endpoint: 'POST /api/email-history', description: 'Create new email history', roles: ['admin', 'operator'] },
      { endpoint: 'PUT /api/email-history/:id', description: 'Update email history', roles: ['admin', 'operator'] },
      { endpoint: 'DELETE /api/email-history/:id', description: 'Delete email history', roles: ['admin'] },
      { endpoint: 'POST /api/email-history/bulk', description: 'Bulk import email history', roles: ['admin', 'operator'] }
    ];
    
    return {
      statusCode: 200,
      body: JSON.stringify({ resources })
    };
  } catch (error) {
    console.error('Error in handleGetResources:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetUsers(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'users#'
      }
    }));
    
    const users = (result.Items || []).map(item => ({
      id: item.id,
      username: item.username,
      email: item.email,
      name: item.name,
      department: item.department,
      role: item.role,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      createdBy: item.createdBy
    }));
    
    return {
      statusCode: 200,
      body: JSON.stringify({ users })
    };
  } catch (error) {
    console.error('Error in handleGetUsers:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetUserById(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    
    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'User ID is required' })
      };
    }
    
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `users#${userId}`,
        sk: 'metadata'
      }
    }));
    
    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify(result.Item)
    };
  } catch (error) {
    console.error('Error in handleGetUserById:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleCreateUser(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');
    
    const validationErrors = validateUser(body);
    if (validationErrors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errors: validationErrors })
      };
    }
    
    const userId = randomUUID();
    const now = Date.now();
    
    const user: User = {
      id: userId,
      username: body.username,
      email: body.email,
      name: body.name,
      department: body.department,
      role: body.role,
      status: body.status,
      createdAt: now,
      updatedAt: now,
      createdBy: authContext.userId
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `users#${userId}`,
        sk: 'metadata',
        ...user
      }
    }));
    
    await writeAuditLog('CREATE_USER', authContext.userId, authContext.username, { userId, user });
    
    return {
      statusCode: 201,
      body: JSON.stringify(user)
    };
  } catch (error) {
    console.error('Error in handleCreateUser:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleUpdateUser(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    
    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'User ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `users#${userId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' })
      };
    }
    
    const updateData: Record<string, any> = {};
    const allowedFields = ['username', 'email', 'name', 'department', 'role', 'status'];
    
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No valid fields to update' })
      };
    }
    
    const partialUser = { ...getResult.Item, ...updateData };
    const validationErrors = validateUser(partialUser);
    if (validationErrors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errors: validationErrors })
      };
    }
    
    const now = Date.now();
    updateData.updatedAt = now;
    
    const updateExpression = Object.keys(updateData).map((key, index) => `${key} = :val${index}`).join(', ');
    const expressionAttributeValues: Record<string, any> = {};
    Object.entries(updateData).forEach(([key, value], index) => {
      expressionAttributeValues[`:val${index}`] = value;
    });
    
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `users#${userId}`,
        sk: 'metadata'
      },
      UpdateExpression: `SET ${updateExpression}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));
    
    await writeAuditLog('UPDATE_USER', authContext.userId, authContext.username, { userId, updates: updateData });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ...getResult.Item, ...updateData })
    };
  } catch (error) {
    console.error('Error in handleUpdateUser:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleDeleteUser(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    
    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'User ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `users#${userId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'User not found' })
      };
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `users#${userId}`,
        sk: 'metadata'
      }
    }));
    
    await writeAuditLog('DELETE_USER', authContext.userId, authContext.username, { userId });
    
    return {
      statusCode: 204,
      body: ''
    };
  } catch (error) {
    console.error('Error in handleDeleteUser:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetReports(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'reports#'
      }
    }));
    
    const reports = (result.Items || []).map(item => ({
      id: item.id,
      userId: item.userId,
      reportDate: item.reportDate,
      content: item.content,
      achievements: item.achievements,
      issues: item.issues,
      nextPlan: item.nextPlan,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
    
    return {
      statusCode: 200,
      body: JSON.stringify({ reports })
    };
  } catch (error) {
    console.error('Error in handleGetReports:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetReportById(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    
    if (!reportId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Report ID is required' })
      };
    }
    
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reports#${reportId}`,
        sk: 'metadata'
      }
    }));
    
    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Report not found' })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify(result.Item)
    };
  } catch (error) {
    console.error('Error in handleGetReportById:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleCreateReport(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');
    
    const validationErrors = validateReport(body);
    if (validationErrors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errors: validationErrors })
      };
    }
    
    const reportId = randomUUID();
    const now = Date.now();
    
    const report: Report = {
      id: reportId,
      userId: body.userId,
      reportDate: body.reportDate,
      content: body.content,
      achievements: body.achievements,
      issues: body.issues,
      nextPlan: body.nextPlan,
      createdAt: now,
      updatedAt: now
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `reports#${reportId}`,
        sk: 'metadata',
        ...report
      }
    }));
    
    await writeAuditLog('CREATE_REPORT', authContext.userId, authContext.username, { reportId, report });
    
    return {
      statusCode: 201,
      body: JSON.stringify(report)
    };
  } catch (error) {
    console.error('Error in handleCreateReport:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleUpdateReport(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    
    if (!reportId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Report ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reports#${reportId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Report not found' })
      };
    }
    
    const updateData: Record<string, any> = {};
    const allowedFields = ['content', 'achievements', 'issues', 'nextPlan'];
    
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No valid fields to update' })
      };
    }
    
    const now = Date.now();
    updateData.updatedAt = now;
    
    const updateExpression = Object.keys(updateData).map((key, index) => `${key} = :val${index}`).join(', ');
    const expressionAttributeValues: Record<string, any> = {};
    Object.entries(updateData).forEach(([key, value], index) => {
      expressionAttributeValues[`:val${index}`] = value;
    });
    
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reports#${reportId}`,
        sk: 'metadata'
      },
      UpdateExpression: `SET ${updateExpression}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));
    
    await writeAuditLog('UPDATE_REPORT', authContext.userId, authContext.username, { reportId, updates: updateData });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ...getResult.Item, ...updateData })
    };
  } catch (error) {
    console.error('Error in handleUpdateReport:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleDeleteReport(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    
    if (!reportId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Report ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reports#${reportId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Report not found' })
      };
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reports#${reportId}`,
        sk: 'metadata'
      }
    }));
    
    await writeAuditLog('DELETE_REPORT', authContext.userId, authContext.username, { reportId });
    
    return {
      statusCode: 204,
      body: ''
    };
  } catch (error) {
    console.error('Error in handleDeleteReport:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetReminders(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'reminders#'
      }
    }));
    
    const reminders = (result.Items || []).map(item => ({
      id: item.id,
      userId: item.userId,
      enabled: item.enabled,
      sendTime: item.sendTime,
      sendDays: item.sendDays,
      sendMethod: item.sendMethod,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
    
    return {
      statusCode: 200,
      body: JSON.stringify({ reminders })
    };
  } catch (error) {
    console.error('Error in handleGetReminders:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetReminderById(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    
    if (!reminderId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Reminder ID is required' })
      };
    }
    
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reminders#${reminderId}`,
        sk: 'metadata'
      }
    }));
    
    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Reminder not found' })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify(result.Item)
    };
  } catch (error) {
    console.error('Error in handleGetReminderById:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleCreateReminder(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');
    
    const validationErrors = validateReminderSetting(body);
    if (validationErrors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errors: validationErrors })
      };
    }
    
    const reminderId = randomUUID();
    const now = Date.now();
    
    const reminder: ReminderSetting = {
      id: reminderId,
      userId: body.userId,
      enabled: body.enabled,
      sendTime: body.sendTime,
      sendDays: body.sendDays,
      sendMethod: body.sendMethod,
      createdAt: now,
      updatedAt: now
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `reminders#${reminderId}`,
        sk: 'metadata',
        ...reminder
      }
    }));
    
    await writeAuditLog('CREATE_REMINDER', authContext.userId, authContext.username, { reminderId, reminder });
    
    return {
      statusCode: 201,
      body: JSON.stringify(reminder)
    };
  } catch (error) {
    console.error('Error in handleCreateReminder:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleUpdateReminder(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    
    if (!reminderId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Reminder ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reminders#${reminderId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Reminder not found' })
      };
    }
    
    const updateData: Record<string, any> = {};
    const allowedFields = ['enabled', 'sendTime', 'sendDays', 'sendMethod'];
    
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No valid fields to update' })
      };
    }
    
    const now = Date.now();
    updateData.updatedAt = now;
    
    const updateExpression = Object.keys(updateData).map((key, index) => `${key} = :val${index}`).join(', ');
    const expressionAttributeValues: Record<string, any> = {};
    Object.entries(updateData).forEach(([key, value], index) => {
      expressionAttributeValues[`:val${index}`] = value;
    });
    
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reminders#${reminderId}`,
        sk: 'metadata'
      },
      UpdateExpression: `SET ${updateExpression}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));
    
    await writeAuditLog('UPDATE_REMINDER', authContext.userId, authContext.username, { reminderId, updates: updateData });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ...getResult.Item, ...updateData })
    };
  } catch (error) {
    console.error('Error in handleUpdateReminder:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleDeleteReminder(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    
    if (!reminderId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Reminder ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reminders#${reminderId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Reminder not found' })
      };
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `reminders#${reminderId}`,
        sk: 'metadata'
      }
    }));
    
    await writeAuditLog('DELETE_REMINDER', authContext.userId, authContext.username, { reminderId });
    
    return {
      statusCode: 204,
      body: ''
    };
  } catch (error) {
    console.error('Error in handleDeleteReminder:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetDetectionLogs(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'detection-logs#'
      }
    }));
    
    const logs = (result.Items || []).map(item => ({
      id: item.id,
      userId: item.userId,
      targetDate: item.targetDate,
      detectedAt: item.detectedAt,
      reminderSent: item.reminderSent,
      reminderSentAt: item.reminderSentAt,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
    
    return {
      statusCode: 200,
      body: JSON.stringify({ logs })
    };
  } catch (error) {
    console.error('Error in handleGetDetectionLogs:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetDetectionLogById(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    
    if (!logId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Log ID is required' })
      };
    }
    
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `detection-logs#${logId}`,
        sk: 'metadata'
      }
    }));
    
    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Detection log not found' })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify(result.Item)
    };
  } catch (error) {
    console.error('Error in handleGetDetectionLogById:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleCreateDetectionLog(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');
    
    const validationErrors = validateDetectionLog(body);
    if (validationErrors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errors: validationErrors })
      };
    }
    
    const logId = randomUUID();
    const now = Date.now();
    
    const log: DetectionLog = {
      id: logId,
      userId: body.userId,
      targetDate: body.targetDate,
      detectedAt: body.detectedAt || now,
      reminderSent: body.reminderSent,
      reminderSentAt: body.reminderSentAt,
      status: body.status,
      createdAt: now,
      updatedAt: now
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `detection-logs#${logId}`,
        sk: 'metadata',
        ...log
      }
    }));
    
    await writeAuditLog('CREATE_DETECTION_LOG', authContext.userId, authContext.username, { logId, log });
    
    return {
      statusCode: 201,
      body: JSON.stringify(log)
    };
  } catch (error) {
    console.error('Error in handleCreateDetectionLog:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleUpdateDetectionLog(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    
    if (!logId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Log ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `detection-logs#${logId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Detection log not found' })
      };
    }
    
    const updateData: Record<string, any> = {};
    const allowedFields = ['reminderSent', 'reminderSentAt', 'status'];
    
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No valid fields to update' })
      };
    }
    
    const now = Date.now();
    updateData.updatedAt = now;
    
    const updateExpression = Object.keys(updateData).map((key, index) => `${key} = :val${index}`).join(', ');
    const expressionAttributeValues: Record<string, any> = {};
    Object.entries(updateData).forEach(([key, value], index) => {
      expressionAttributeValues[`:val${index}`] = value;
    });
    
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `detection-logs#${logId}`,
        sk: 'metadata'
      },
      UpdateExpression: `SET ${updateExpression}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));
    
    await writeAuditLog('UPDATE_DETECTION_LOG', authContext.userId, authContext.username, { logId, updates: updateData });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ...getResult.Item, ...updateData })
    };
  } catch (error) {
    console.error('Error in handleUpdateDetectionLog:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleDeleteDetectionLog(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    
    if (!logId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Log ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `detection-logs#${logId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Detection log not found' })
      };
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `detection-logs#${logId}`,
        sk: 'metadata'
      }
    }));
    
    await writeAuditLog('DELETE_DETECTION_LOG', authContext.userId, authContext.username, { logId });
    
    return {
      statusCode: 204,
      body: ''
    };
  } catch (error) {
    console.error('Error in handleDeleteDetectionLog:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetEmailHistory(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: {
        ':prefix': 'email-history#'
      }
    }));
    
    const emails = (result.Items || []).map(item => ({
      id: item.id,
      userId: item.userId,
      emailType: item.emailType,
      toAddress: item.toAddress,
      subject: item.subject,
      body: item.body,
      sentAt: item.sentAt,
      status: item.status,
      errorMessage: item.errorMessage,
      relatedReportId: item.relatedReportId,
      relatedReminderId: item.relatedReminderId,
      retryFlag: item.retryFlag,
      createdAt: item.createdAt
    }));
    
    return {
      statusCode: 200,
      body: JSON.stringify({ emails })
    };
  } catch (error) {
    console.error('Error in handleGetEmailHistory:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleGetEmailHistoryById(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    
    if (!emailId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email ID is required' })
      };
    }
    
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `email-history#${emailId}`,
        sk: 'metadata'
      }
    }));
    
    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Email history not found' })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify(result.Item)
    };
  } catch (error) {
    console.error('Error in handleGetEmailHistoryById:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleCreateEmailHistory(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');
    
    const validationErrors = validateEmailHistory(body);
    if (validationErrors.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ errors: validationErrors })
      };
    }
    
    const emailId = randomUUID();
    const now = Date.now();
    
    const email: EmailHistory = {
      id: emailId,
      userId: body.userId,
      emailType: body.emailType,
      toAddress: body.toAddress,
      subject: body.subject,
      body: body.body,
      sentAt: body.sentAt || now,
      status: body.status,
      errorMessage: body.errorMessage,
      relatedReportId: body.relatedReportId,
      relatedReminderId: body.relatedReminderId,
      retryFlag: body.retryFlag,
      createdAt: now
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `email-history#${emailId}`,
        sk: 'metadata',
        ...email
      }
    }));
    
    await writeAuditLog('CREATE_EMAIL_HISTORY', authContext.userId, authContext.username, { emailId, email });
    
    return {
      statusCode: 201,
      body: JSON.stringify(email)
    };
  } catch (error) {
    console.error('Error in handleCreateEmailHistory:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleUpdateEmailHistory(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');
    
    if (!emailId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `email-history#${emailId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Email history not found' })
      };
    }
    
    const updateData: Record<string, any> = {};
    const allowedFields = ['status', 'errorMessage', 'retryFlag'];
    
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }
    
    if (Object.keys(updateData).length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No valid fields to update' })
      };
    }
    
    const updateExpression = Object.keys(updateData).map((key, index) => `${key} = :val${index}`).join(', ');
    const expressionAttributeValues: Record<string, any> = {};
    Object.entries(updateData).forEach(([key, value], index) => {
      expressionAttributeValues[`:val${index}`] = value;
    });
    
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `email-history#${emailId}`,
        sk: 'metadata'
      },
      UpdateExpression: `SET ${updateExpression}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));
    
    await writeAuditLog('UPDATE_EMAIL_HISTORY', authContext.userId, authContext.username, { emailId, updates: updateData });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ ...getResult.Item, ...updateData })
    };
  } catch (error) {
    console.error('Error in handleUpdateEmailHistory:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleDeleteEmailHistory(event: APIGatewayProxyEvent, authContext: any): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    
    if (!emailId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email ID is required' })
      };
    }
    
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `email-history#${emailId}`,
        sk: 'metadata'
      }
    }));
    
    if (!getResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Email history not found' })
      };
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `email-history#${emailId}`,
        sk: 'metadata'
      }
    }));
    
    await writeAuditLog('DELETE_EMAIL_HISTORY', authContext.userId, authContext.username, { emailId });
    
    return {
      statusCode: 204,
      body: ''
    };
  } catch (error) {
    console.error('Error in handleDeleteEmailHistory:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent, authContext: any, tableType: TableType): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];
    
    if (!Array.isArray(items) || items.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'items must be a non-empty array' })
      };
    }
    
    const now = Date.now();
    const processedItems: Record<string, any>[] = [];
    
    for (const item of items) {
      const id = item.id || randomUUID();
      const processedItem = {
        ...item,
        id,
        createdAt: item.createdAt || now,
        updatedAt: item.updatedAt || now
      };
      
      let validationErrors: string[] = [];
      
      if (tableType === 'users') {
        validationErrors = validateUser(processedItem);
      } else if (tableType === 'reports') {
        validationErrors = validateReport(processedItem);
      } else if (tableType === 'reminders') {
        validationErrors = validateReminderSetting(processedItem);
      } else if (tableType === 'detection-logs') {
        validationErrors = validateDetectionLog(processedItem);
      } else if (tableType === 'email-history') {
        validationErrors = validateEmailHistory(processedItem);
      }
      
      if (validationErrors.length === 0) {
        processedItems.push(processedItem);
      }
    }
    
    const tablePrefix = tableType === 'detection-logs' ? 'detection-logs' : tableType;
    const batchSize = 25;
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (let i = 0; i < processedItems.length; i += batchSize) {
      const batch = processedItems.slice(i, i + batchSize);
      const writeRequests = batch.map(item => ({
        PutRequest: {
          Item: {
            pk: `${tablePrefix}#${item.id}`,
            sk: 'metadata',
            ...item
          }
        }
      }));
      
      try {
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        }));
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${error}`);
      }
    }
    
    await writeAuditLog('BULK_IMPORT', authContext.userId, authContext.username, {
      tableType,
      imported,
      failed,
      total: items.length
    });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ imported, failed, errors })
    };
  } catch (error) {
    console.error('Error in handleBulkImport:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const authContext = extractAuthContext(event);
  const method = event.httpMethod;
  const path = event.path;
  
  console.log(`${method} ${path} - User: ${authContext.userId}, Role: ${authContext.role}`);
  
  if (!checkPermission(method, path, authContext.role)) {
    return createForbiddenResponse();
  }
  
  try {
    if (path === '/resources' && method === 'GET') {
      return await handleGetResources(event, authContext);
    }
    
    if (path === '/api/users' && method === 'GET') {
      return await handleGetUsers(event, authContext);
    }
    if (path.match(/^\/api\/users\/[^/]+$/) && method === 'GET') {
      return await handleGetUserById(event, authContext);
    }
    if (path === '/api/users' && method === 'POST') {
      return await handleCreateUser(event, authContext);
    }
    if (path.match(/^\/api\/users\/[^/]+$/) && method === 'PUT') {
      return await handleUpdateUser(event, authContext);
    }
    if (path.match(/^\/api\/users\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteUser(event, authContext);
    }
    if (path === '/api/users/bulk' && method === 'POST') {
      return await handleBulkImport(event, authContext, 'users');
    }
    
    if (path === '/api/reports' && method === 'GET') {
      return await handleGetReports(event, authContext);
    }
    if (path.match(/^\/api\/reports\/[^/]+$/) && method === 'GET') {
      return await handleGetReportById(event, authContext);
    }
    if (path === '/api/reports' && method === 'POST') {
      return await handleCreateReport(event, authContext);
    }
    if (path.match(/^\/api\/reports\/[^/]+$/) && method === 'PUT') {
      return await handleUpdateReport(event, authContext);
    }
    if (path.match(/^\/api\/reports\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteReport(event, authContext);
    }
    if (path === '/api/reports/bulk' && method === 'POST') {
      return await handleBulkImport(event, authContext, 'reports');
    }
    
    if (path === '/api/reminders' && method === 'GET') {
      return await handleGetReminders(event, authContext);
    }
    if (path.match(/^\/api\/reminders\/[^/]+$/) && method === 'GET') {
      return await handleGetReminderById(event, authContext);
    }
    if (path === '/api/reminders' && method === 'POST') {
      return await handleCreateReminder(event, authContext);
    }
    if (path.match(/^\/api\/reminders\/[^/]+$/) && method === 'PUT') {
      return await handleUpdateReminder(event, authContext);
    }
    if (path.match(/^\/api\/reminders\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteReminder(event, authContext);
    }
    if (path === '/api/reminders/bulk' && method === 'POST') {
      return await handleBulkImport(event, authContext, 'reminders');
    }
    
    if (path === '/api/detection-logs' && method === 'GET') {
      return await handleGetDetectionLogs(event, authContext);
    }
    if (path.match(/^\/api\/detection-logs\/[^/]+$/) && method === 'GET') {
      return await handleGetDetectionLogById(event, authContext);
    }
    if (path === '/api/detection-logs' && method === 'POST') {
      return await handleCreateDetectionLog(event, authContext);
    }
    if (path.match(/^\/api\/detection-logs\/[^/]+$/) && method === 'PUT') {
      return await handleUpdateDetectionLog(event, authContext);
    }
    if (path.match(/^\/api\/detection-logs\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteDetectionLog(event, authContext);
    }
    if (path === '/api/detection-logs/bulk' && method === 'POST') {
      return await handleBulkImport(event, authContext, 'detection-logs');
    }
    
    if (path === '/api/email-history' && method === 'GET') {
      return await handleGetEmailHistory(event, authContext);
    }
    if (path.match(/^\/api\/email-history\/[^/]+$/) && method === 'GET') {
      return await handleGetEmailHistoryById(event, authContext);
    }
    if (path === '/api/email-history' && method === 'POST') {
      return await handleCreateEmailHistory(event, authContext);
    }
    if (path.match(/^\/api\/email-history\/[^/]+$/) && method === 'PUT') {
      return await handleUpdateEmailHistory(event, authContext);
    }
    if (path.match(/^\/api\/email-history\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteEmailHistory(event, authContext);
    }
    if (path === '/api/email-history/bulk' && method === 'POST') {
      return await handleBulkImport(event, authContext, 'email-history');
    }
    
    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'Not found' })
    };
  } catch (error) {
    console.error('Unhandled error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};