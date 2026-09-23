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
import { v4 as uuidv4 } from 'uuid';
import { authorizeRequest, Role } from './rbac';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.MAIN_TABLE || 'daily-report-system';

interface User {
  pk: string;
  sk: string;
  userId: string;
  username: string;
  email: string;
  fullName: string;
  department?: string;
  role: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

interface DailyReport {
  pk: string;
  sk: string;
  reportId: string;
  userId: string;
  reportDate: number;
  taskContent: string;
  achievement?: string;
  issues?: string;
  nextDayPlan?: string;
  createdAt: number;
  updatedAt: number;
}

interface ReminderSetting {
  pk: string;
  sk: string;
  reminderId: string;
  userId: string;
  enabled: boolean;
  sendTime: string;
  sendDays?: string;
  sendMethod: string;
  createdAt: number;
  updatedAt: number;
}

interface DetectionLog {
  pk: string;
  sk: string;
  logId: string;
  userId: string;
  targetDate: number;
  detectionTime: number;
  reminderSent: boolean;
  reminderSentTime?: number;
  submissionStatus: string;
  createdAt: number;
  updatedAt: number;
}

interface EmailHistory {
  pk: string;
  sk: string;
  emailId: string;
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

interface AuditLog {
  pk: string;
  sk: string;
  action: string;
  entityType: string;
  entityId: string;
  userId: string;
  changes: Record<string, unknown>;
  timestamp: number;
}

function createAuditLog(
  action: string,
  entityType: string,
  entityId: string,
  userId: string,
  changes: Record<string, unknown>
): AuditLog {
  return {
    pk: 'AUDIT',
    sk: `${entityType}#${entityId}#${Date.now()}`,
    action,
    entityType,
    entityId,
    userId,
    changes,
    timestamp: Date.now()
  };
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validateRole(role: string): boolean {
  return ['admin', 'operator', 'viewer'].includes(role);
}

function validateStatus(status: string): boolean {
  return ['active', 'inactive', 'suspended'].includes(status);
}

function validateSendMethod(method: string): boolean {
  return ['email', 'app-notification', 'sms'].includes(method);
}

function validateSubmissionStatus(status: string): boolean {
  return ['not-submitted', 'submitted', 'overdue'].includes(status);
}

function validateEmailStatus(status: string): boolean {
  return ['success', 'failed', 'pending'].includes(status);
}

async function createResponse(
  statusCode: number,
  body: Record<string, unknown>
): Promise<APIGatewayProxyResult> {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

// User endpoints
async function handleGetUsers(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator', 'viewer']);

    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'USER'
        }
      })
    );

    return createResponse(200, {
      success: true,
      data: result.Items || [],
      count: result.Items?.length || 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleGetUser(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator', 'viewer']);

    const userId = event.pathParameters?.id;
    if (!userId) {
      return createResponse(400, { success: false, error: 'Missing user ID' });
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `USER#${userId}`,
          sk: 'PROFILE'
        }
      })
    );

    if (!result.Item) {
      return createResponse(404, { success: false, error: 'User not found' });
    }

    return createResponse(200, { success: true, data: result.Item });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleCreateUser(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.username || !body.email || !body.fullName || !body.role) {
      return createResponse(400, {
        success: false,
        error: 'Missing required fields: username, email, fullName, role'
      });
    }

    if (!validateEmail(body.email)) {
      return createResponse(400, { success: false, error: 'Invalid email format' });
    }

    if (!validateRole(body.role)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid role. Must be admin, operator, or viewer'
      });
    }

    if (!validateStatus(body.status || 'active')) {
      return createResponse(400, {
        success: false,
        error: 'Invalid status. Must be active, inactive, or suspended'
      });
    }

    const userId = uuidv4();
    const now = Date.now();

    const user: User = {
      pk: `USER#${userId}`,
      sk: 'PROFILE',
      userId,
      username: body.username,
      email: body.email,
      fullName: body.fullName,
      department: body.department,
      role: body.role,
      status: body.status || 'active',
      createdAt: now,
      updatedAt: now,
      createdBy: authContext.userId
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: user
      })
    );

    const auditLog = createAuditLog('CREATE', 'USER', userId, authContext.userId, {
      username: body.username,
      email: body.email,
      role: body.role
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(201, { success: true, data: user });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleUpdateUser(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return createResponse(400, { success: false, error: 'Missing user ID' });
    }

    const body = JSON.parse(event.body || '{}');

    if (body.email && !validateEmail(body.email)) {
      return createResponse(400, { success: false, error: 'Invalid email format' });
    }

    if (body.role && !validateRole(body.role)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid role. Must be admin, operator, or viewer'
      });
    }

    if (body.status && !validateStatus(body.status)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid status. Must be active, inactive, or suspended'
      });
    }

    const updateExpressions: string[] = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.username) {
      updateExpressions.push('username = :username');
      expressionAttributeValues[':username'] = body.username;
    }
    if (body.email) {
      updateExpressions.push('email = :email');
      expressionAttributeValues[':email'] = body.email;
    }
    if (body.fullName) {
      updateExpressions.push('fullName = :fullName');
      expressionAttributeValues[':fullName'] = body.fullName;
    }
    if (body.department) {
      updateExpressions.push('department = :department');
      expressionAttributeValues[':department'] = body.department;
    }
    if (body.role) {
      updateExpressions.push('role = :role');
      expressionAttributeValues[':role'] = body.role;
    }
    if (body.status) {
      updateExpressions.push('#status = :status');
      expressionAttributeValues[':status'] = body.status;
    }

    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = Date.now();

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `USER#${userId}`,
          sk: 'PROFILE'
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: body.status ? { '#status': 'status' } : undefined,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    const auditLog = createAuditLog('UPDATE', 'USER', userId, authContext.userId, body);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, data: result.Attributes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleDeleteUser(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return createResponse(400, { success: false, error: 'Missing user ID' });
    }

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          pk: `USER#${userId}`,
          sk: 'PROFILE'
        }
      })
    );

    const auditLog = createAuditLog('DELETE', 'USER', userId, authContext.userId, {});
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, message: 'User deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

// Daily Report endpoints
async function handleGetDailyReports(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator', 'viewer']);

    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'REPORT'
        }
      })
    );

    return createResponse(200, {
      success: true,
      data: result.Items || [],
      count: result.Items?.length || 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleGetDailyReport(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator', 'viewer']);

    const reportId = event.pathParameters?.id;
    if (!reportId) {
      return createResponse(400, { success: false, error: 'Missing report ID' });
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `REPORT#${reportId}`,
          sk: 'DATA'
        }
      })
    );

    if (!result.Item) {
      return createResponse(404, { success: false, error: 'Report not found' });
    }

    return createResponse(200, { success: true, data: result.Item });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleCreateDailyReport(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.userId || !body.reportDate || !body.taskContent) {
      return createResponse(400, {
        success: false,
        error: 'Missing required fields: userId, reportDate, taskContent'
      });
    }

    const reportId = uuidv4();
    const now = Date.now();

    const report: DailyReport = {
      pk: `REPORT#${reportId}`,
      sk: 'DATA',
      reportId,
      userId: body.userId,
      reportDate: body.reportDate,
      taskContent: body.taskContent,
      achievement: body.achievement,
      issues: body.issues,
      nextDayPlan: body.nextDayPlan,
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: report
      })
    );

    const auditLog = createAuditLog('CREATE', 'REPORT', reportId, authContext.userId, {
      userId: body.userId,
      reportDate: body.reportDate
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(201, { success: true, data: report });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleUpdateDailyReport(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    if (!reportId) {
      return createResponse(400, { success: false, error: 'Missing report ID' });
    }

    const body = JSON.parse(event.body || '{}');

    const updateExpressions: string[] = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.taskContent) {
      updateExpressions.push('taskContent = :taskContent');
      expressionAttributeValues[':taskContent'] = body.taskContent;
    }
    if (body.achievement) {
      updateExpressions.push('achievement = :achievement');
      expressionAttributeValues[':achievement'] = body.achievement;
    }
    if (body.issues) {
      updateExpressions.push('issues = :issues');
      expressionAttributeValues[':issues'] = body.issues;
    }
    if (body.nextDayPlan) {
      updateExpressions.push('nextDayPlan = :nextDayPlan');
      expressionAttributeValues[':nextDayPlan'] = body.nextDayPlan;
    }

    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = Date.now();

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `REPORT#${reportId}`,
          sk: 'DATA'
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    const auditLog = createAuditLog('UPDATE', 'REPORT', reportId, authContext.userId, body);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, data: result.Attributes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleDeleteDailyReport(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    if (!reportId) {
      return createResponse(400, { success: false, error: 'Missing report ID' });
    }

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          pk: `REPORT#${reportId}`,
          sk: 'DATA'
        }
      })
    );

    const auditLog = createAuditLog('DELETE', 'REPORT', reportId, authContext.userId, {});
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, message: 'Report deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

// Reminder Settings endpoints
async function handleGetReminderSettings(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator', 'viewer']);

    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'REMINDER'
        }
      })
    );

    return createResponse(200, {
      success: true,
      data: result.Items || [],
      count: result.Items?.length || 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleGetReminderSetting(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator', 'viewer']);

    const reminderId = event.pathParameters?.id;
    if (!reminderId) {
      return createResponse(400, { success: false, error: 'Missing reminder ID' });
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `REMINDER#${reminderId}`,
          sk: 'CONFIG'
        }
      })
    );

    if (!result.Item) {
      return createResponse(404, { success: false, error: 'Reminder setting not found' });
    }

    return createResponse(200, { success: true, data: result.Item });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleCreateReminderSetting(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (
      body.userId === undefined ||
      body.enabled === undefined ||
      !body.sendTime ||
      !body.sendMethod
    ) {
      return createResponse(400, {
        success: false,
        error: 'Missing required fields: userId, enabled, sendTime, sendMethod'
      });
    }

    if (!/^\d{2}:\d{2}$/.test(body.sendTime)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid sendTime format. Use HH:MM'
      });
    }

    if (!validateSendMethod(body.sendMethod)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid sendMethod. Must be email, app-notification, or sms'
      });
    }

    const reminderId = uuidv4();
    const now = Date.now();

    const reminder: ReminderSetting = {
      pk: `REMINDER#${reminderId}`,
      sk: 'CONFIG',
      reminderId,
      userId: body.userId,
      enabled: body.enabled,
      sendTime: body.sendTime,
      sendDays: body.sendDays,
      sendMethod: body.sendMethod,
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: reminder
      })
    );

    const auditLog = createAuditLog('CREATE', 'REMINDER', reminderId, authContext.userId, {
      userId: body.userId,
      sendMethod: body.sendMethod
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(201, { success: true, data: reminder });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleUpdateReminderSetting(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    if (!reminderId) {
      return createResponse(400, { success: false, error: 'Missing reminder ID' });
    }

    const body = JSON.parse(event.body || '{}');

    if (body.sendTime && !/^\d{2}:\d{2}$/.test(body.sendTime)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid sendTime format. Use HH:MM'
      });
    }

    if (body.sendMethod && !validateSendMethod(body.sendMethod)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid sendMethod. Must be email, app-notification, or sms'
      });
    }

    const updateExpressions: string[] = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.enabled !== undefined) {
      updateExpressions.push('enabled = :enabled');
      expressionAttributeValues[':enabled'] = body.enabled;
    }
    if (body.sendTime) {
      updateExpressions.push('sendTime = :sendTime');
      expressionAttributeValues[':sendTime'] = body.sendTime;
    }
    if (body.sendDays) {
      updateExpressions.push('sendDays = :sendDays');
      expressionAttributeValues[':sendDays'] = body.sendDays;
    }
    if (body.sendMethod) {
      updateExpressions.push('sendMethod = :sendMethod');
      expressionAttributeValues[':sendMethod'] = body.sendMethod;
    }

    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = Date.now();

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `REMINDER#${reminderId}`,
          sk: 'CONFIG'
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    const auditLog = createAuditLog('UPDATE', 'REMINDER', reminderId, authContext.userId, body);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, data: result.Attributes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleDeleteReminderSetting(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    if (!reminderId) {
      return createResponse(400, { success: false, error: 'Missing reminder ID' });
    }

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          pk: `REMINDER#${reminderId}`,
          sk: 'CONFIG'
        }
      })
    );

    const auditLog = createAuditLog('DELETE', 'REMINDER', reminderId, authContext.userId, {});
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, message: 'Reminder setting deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

// Detection Log endpoints
async function handleGetDetectionLogs(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator']);

    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'DETECTION'
        }
      })
    );

    return createResponse(200, {
      success: true,
      data: result.Items || [],
      count: result.Items?.length || 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleGetDetectionLog(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator']);

    const logId = event.pathParameters?.id;
    if (!logId) {
      return createResponse(400, { success: false, error: 'Missing log ID' });
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `DETECTION#${logId}`,
          sk: 'LOG'
        }
      })
    );

    if (!result.Item) {
      return createResponse(404, { success: false, error: 'Detection log not found' });
    }

    return createResponse(200, { success: true, data: result.Item });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleCreateDetectionLog(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (
      !body.userId ||
      !body.targetDate ||
      body.reminderSent === undefined ||
      !body.submissionStatus
    ) {
      return createResponse(400, {
        success: false,
        error: 'Missing required fields: userId, targetDate, reminderSent, submissionStatus'
      });
    }

    if (!validateSubmissionStatus(body.submissionStatus)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid submissionStatus. Must be not-submitted, submitted, or overdue'
      });
    }

    const logId = uuidv4();
    const now = Date.now();

    const log: DetectionLog = {
      pk: `DETECTION#${logId}`,
      sk: 'LOG',
      logId,
      userId: body.userId,
      targetDate: body.targetDate,
      detectionTime: now,
      reminderSent: body.reminderSent,
      reminderSentTime: body.reminderSentTime,
      submissionStatus: body.submissionStatus,
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: log
      })
    );

    const auditLog = createAuditLog('CREATE', 'DETECTION', logId, authContext.userId, {
      userId: body.userId,
      submissionStatus: body.submissionStatus
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(201, { success: true, data: log });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleUpdateDetectionLog(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    if (!logId) {
      return createResponse(400, { success: false, error: 'Missing log ID' });
    }

    const body = JSON.parse(event.body || '{}');

    if (body.submissionStatus && !validateSubmissionStatus(body.submissionStatus)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid submissionStatus. Must be not-submitted, submitted, or overdue'
      });
    }

    const updateExpressions: string[] = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.reminderSent !== undefined) {
      updateExpressions.push('reminderSent = :reminderSent');
      expressionAttributeValues[':reminderSent'] = body.reminderSent;
    }
    if (body.reminderSentTime) {
      updateExpressions.push('reminderSentTime = :reminderSentTime');
      expressionAttributeValues[':reminderSentTime'] = body.reminderSentTime;
    }
    if (body.submissionStatus) {
      updateExpressions.push('submissionStatus = :submissionStatus');
      expressionAttributeValues[':submissionStatus'] = body.submissionStatus;
    }

    updateExpressions.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = Date.now();

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `DETECTION#${logId}`,
          sk: 'LOG'
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    const auditLog = createAuditLog('UPDATE', 'DETECTION', logId, authContext.userId, body);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, data: result.Attributes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleDeleteDetectionLog(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    if (!logId) {
      return createResponse(400, { success: false, error: 'Missing log ID' });
    }

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          pk: `DETECTION#${logId}`,
          sk: 'LOG'
        }
      })
    );

    const auditLog = createAuditLog('DELETE', 'DETECTION', logId, authContext.userId, {});
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, message: 'Detection log deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

// Email History endpoints
async function handleGetEmailHistory(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator']);

    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'EMAIL'
        }
      })
    );

    return createResponse(200, {
      success: true,
      data: result.Items || [],
      count: result.Items?.length || 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleGetEmailHistoryItem(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    authorizeRequest(event, ['admin', 'operator']);

    const emailId = event.pathParameters?.id;
    if (!emailId) {
      return createResponse(400, { success: false, error: 'Missing email ID' });
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `EMAIL#${emailId}`,
          sk: 'HISTORY'
        }
      })
    );

    if (!result.Item) {
      return createResponse(404, { success: false, error: 'Email history not found' });
    }

    return createResponse(200, { success: true, data: result.Item });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleCreateEmailHistory(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (
      !body.userId ||
      !body.emailType ||
      !body.toAddress ||
      !body.subject ||
      !body.body ||
      !body.status
    ) {
      return createResponse(400, {
        success: false,
        error: 'Missing required fields: userId, emailType, toAddress, subject, body, status'
      });
    }

    if (!validateEmail(body.toAddress)) {
      return createResponse(400, { success: false, error: 'Invalid email address' });
    }

    if (!validateEmailStatus(body.status)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid status. Must be success, failed, or pending'
      });
    }

    const emailId = uuidv4();
    const now = Date.now();

    const email: EmailHistory = {
      pk: `EMAIL#${emailId}`,
      sk: 'HISTORY',
      emailId,
      userId: body.userId,
      emailType: body.emailType,
      toAddress: body.toAddress,
      subject: body.subject,
      body: body.body,
      sentAt: now,
      status: body.status,
      errorMessage: body.errorMessage,
      relatedReportId: body.relatedReportId,
      relatedReminderId: body.relatedReminderId,
      retryFlag: body.retryFlag || false,
      createdAt: now
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: email
      })
    );

    const auditLog = createAuditLog('CREATE', 'EMAIL', emailId, authContext.userId, {
      userId: body.userId,
      emailType: body.emailType,
      status: body.status
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(201, { success: true, data: email });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleUpdateEmailHistory(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    if (!emailId) {
      return createResponse(400, { success: false, error: 'Missing email ID' });
    }

    const body = JSON.parse(event.body || '{}');

    if (body.status && !validateEmailStatus(body.status)) {
      return createResponse(400, {
        success: false,
        error: 'Invalid status. Must be success, failed, or pending'
      });
    }

    const updateExpressions: string[] = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.status) {
      updateExpressions.push('#status = :status');
      expressionAttributeValues[':status'] = body.status;
    }
    if (body.errorMessage) {
      updateExpressions.push('errorMessage = :errorMessage');
      expressionAttributeValues[':errorMessage'] = body.errorMessage;
    }
    if (body.retryFlag !== undefined) {
      updateExpressions.push('retryFlag = :retryFlag');
      expressionAttributeValues[':retryFlag'] = body.retryFlag;
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `EMAIL#${emailId}`,
          sk: 'HISTORY'
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    const auditLog = createAuditLog('UPDATE', 'EMAIL', emailId, authContext.userId, body);
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, data: result.Attributes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

async function handleDeleteEmailHistory(
  event: APIGatewayProxyEvent,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    if (!emailId) {
      return createResponse(400, { success: false, error: 'Missing email ID' });
    }

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          pk: `EMAIL#${emailId}`,
          sk: 'HISTORY'
        }
      })
    );

    const auditLog = createAuditLog('DELETE', 'EMAIL', emailId, authContext.userId, {});
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, { success: true, message: 'Email history deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Insufficient permissions') {
      return createResponse(403, { success: false, error: message });
    }
    return createResponse(500, { success: false, error: message });
  }
}

// Bulk import endpoints
async function handleBulkImport(
  event: APIGatewayProxyEvent,
  entityType: string,
  authContext: ReturnType<typeof authorizeRequest>
): Promise<APIGatewayProxyResult> {
  try {
    if (!['admin', 'operator'].includes(authContext.role)) {
      return createResponse(403, {
        success: false,
        error: 'Only admin and operator roles can perform bulk imports'
      });
    }

    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      return createResponse(400, {
        success: false,
        error: 'items must be a non-empty array'
      });
    }

    const now = Date.now();
    const processedItems: Record<string, unknown>[] = [];
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const processedItem: Record<string, unknown> = {
          ...item,
          id: item.id || uuidv4(),
          createdAt: item.createdAt || now,
          updatedAt: item.updatedAt || now
        };

        // Add entity-specific pk and sk
        if (entityType === 'users') {
          processedItem.pk = `USER#${processedItem.id}`;
          processedItem.sk = 'PROFILE';
        } else if (entityType === 'daily-reports') {
          processedItem.pk = `REPORT#${processedItem.id}`;
          processedItem.sk = 'DATA';
        } else if (entityType === 'reminder-settings') {
          processedItem.pk = `REMINDER#${processedItem.id}`;
          processedItem.sk = 'CONFIG';
        } else if (entityType === 'detection-logs') {
          processedItem.pk = `DETECTION#${processedItem.id}`;
          processedItem.sk = 'LOG';
        } else if (entityType === 'email-history') {
          processedItem.pk = `EMAIL#${processedItem.id}`;
          processedItem.sk = 'HISTORY';
        }

        processedItems.push(processedItem);
      } catch (error) {
        errors.push(`Item ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Batch write in chunks of 25
    let imported = 0;
    const chunkSize = 25;

    for (let i = 0; i < processedItems.length; i += chunkSize) {
      const chunk = processedItems.slice(i, i + chunkSize);
      const requestItems: Record<string, unknown>[] = [];

      for (const item of chunk) {
        requestItems.push({
          PutRequest: {
            Item: item
          }
        });
      }

      try {
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: requestItems as any
            }
          })
        );
        imported += chunk.length;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Batch write failed: ${errorMsg}`);
      }
    }

    // Create audit log for bulk import
    const auditLog = createAuditLog('BULK_IMPORT', entityType.toUpperCase(), 'BATCH', authContext.userId, {
      itemCount: imported,
      errorCount: errors.length
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: auditLog
      })
    );

    return createResponse(200, {
      success: true,
      imported,
      failed: errors.length,
      errors
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return createResponse(500, { success: false, error: message });
  }
}

// Main handler
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const path = event.path || '';
  const method = event.httpMethod || 'GET';

  try {
    // GET /resources endpoint
    if (method === 'GET' && path === '/resources') {
      const authContext = authorizeRequest(event, ['admin', 'operator', 'viewer']);
      return createResponse(200, {
        success: true,
        resources: [
          { name: 'users', endpoint: '/users' },
          { name: 'daily-reports', endpoint: '/daily-reports' },
          { name: 'reminder-settings', endpoint: '/reminder-settings' },
          { name: 'detection-logs', endpoint: '/detection-logs' },
          { name: 'email-history', endpoint: '/email-history' }
        ]
      });
    }

    // User endpoints
    if (path === '/users' && method === 'GET') {
      return handleGetUsers(event);
    }
    if (path.match(/^\/users\/[^/]+$/) && method === 'GET') {
      return handleGetUser(event);
    }
    if (path === '/users' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin']);
      return handleCreateUser(event, authContext);
    }
    if (path.match(/^\/users\/[^/]+$/) && method === 'PUT') {
      const authContext = authorizeRequest(event, ['admin']);
      return handleUpdateUser(event, authContext);
    }
    if (path.match(/^\/users\/[^/]+$/) && method === 'DELETE') {
      const authContext = authorizeRequest(event, ['admin']);
      return handleDeleteUser(event, authContext);
    }
    if (path === '/api/users/bulk' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleBulkImport(event, 'users', authContext);
    }

    // Daily Report endpoints
    if (path === '/daily-reports' && method === 'GET') {
      return handleGetDailyReports(event);
    }
    if (path.match(/^\/daily-reports\/[^/]+$/) && method === 'GET') {
      return handleGetDailyReport(event);
    }
    if (path === '/daily-reports' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator', 'viewer']);
      return handleCreateDailyReport(event, authContext);
    }
    if (path.match(/^\/daily-reports\/[^/]+$/) && method === 'PUT') {
      const authContext = authorizeRequest(event, ['admin', 'operator', 'viewer']);
      return handleUpdateDailyReport(event, authContext);
    }
    if (path.match(/^\/daily-reports\/[^/]+$/) && method === 'DELETE') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleDeleteDailyReport(event, authContext);
    }
    if (path === '/api/daily-reports/bulk' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleBulkImport(event, 'daily-reports', authContext);
    }

    // Reminder Settings endpoints
    if (path === '/reminder-settings' && method === 'GET') {
      return handleGetReminderSettings(event);
    }
    if (path.match(/^\/reminder-settings\/[^/]+$/) && method === 'GET') {
      return handleGetReminderSetting(event);
    }
    if (path === '/reminder-settings' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleCreateReminderSetting(event, authContext);
    }
    if (path.match(/^\/reminder-settings\/[^/]+$/) && method === 'PUT') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleUpdateReminderSetting(event, authContext);
    }
    if (path.match(/^\/reminder-settings\/[^/]+$/) && method === 'DELETE') {
      const authContext = authorizeRequest(event, ['admin']);
      return handleDeleteReminderSetting(event, authContext);
    }
    if (path === '/api/reminder-settings/bulk' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleBulkImport(event, 'reminder-settings', authContext);
    }

    // Detection Log endpoints
    if (path === '/detection-logs' && method === 'GET') {
      return handleGetDetectionLogs(event);
    }
    if (path.match(/^\/detection-logs\/[^/]+$/) && method === 'GET') {
      return handleGetDetectionLog(event);
    }
    if (path === '/detection-logs' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleCreateDetectionLog(event, authContext);
    }
    if (path.match(/^\/detection-logs\/[^/]+$/) && method === 'PUT') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleUpdateDetectionLog(event, authContext);
    }
    if (path.match(/^\/detection-logs\/[^/]+$/) && method === 'DELETE') {
      const authContext = authorizeRequest(event, ['admin']);
      return handleDeleteDetectionLog(event, authContext);
    }
    if (path === '/api/detection-logs/bulk' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleBulkImport(event, 'detection-logs', authContext);
    }

    // Email History endpoints
    if (path === '/email-history' && method === 'GET') {
      return handleGetEmailHistory(event);
    }
    if (path.match(/^\/email-history\/[^/]+$/) && method === 'GET') {
      return handleGetEmailHistoryItem(event);
    }
    if (path === '/email-history' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleCreateEmailHistory(event, authContext);
    }
    if (path.match(/^\/email-history\/[^/]+$/) && method === 'PUT') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleUpdateEmailHistory(event, authContext);
    }
    if (path.match(/^\/email-history\/[^/]+$/) && method === 'DELETE') {
      const authContext = authorizeRequest(event, ['admin']);
      return handleDeleteEmailHistory(event, authContext);
    }
    if (path === '/api/email-history/bulk' && method === 'POST') {
      const authContext = authorizeRequest(event, ['admin', 'operator']);
      return handleBulkImport(event, 'email-history', authContext);
    }

    return createResponse(404, { success: false, error: 'Endpoint not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return createResponse(500, { success: false, error: message });
  }
};