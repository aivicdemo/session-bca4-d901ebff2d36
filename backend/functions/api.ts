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
import { checkPermission, extractAuthContext, AuthContext } from './rbac';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'daily-report-system';

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
  workContent: string;
  achievements?: string;
  issues?: string;
  tomorrowPlan?: string;
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
  detectedAt: number;
  reminderSent: boolean;
  reminderSentAt?: number;
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
  userId: string;
  resource: string;
  resourceId: string;
  changes: Record<string, unknown>;
  timestamp: number;
}

function createErrorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({ error: message })
  };
}

function createSuccessResponse(statusCode: number, data: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify(data)
  };
}

async function createAuditLog(
  action: string,
  userId: string,
  resource: string,
  resourceId: string,
  changes: Record<string, unknown>
): Promise<void> {
  const auditLog: AuditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    action,
    userId,
    resource,
    resourceId,
    changes,
    timestamp: Date.now()
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    })
  );
}

async function handleGetResources(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const resources = [
      { name: 'users', description: 'User management' },
      { name: 'daily-reports', description: 'Daily reports' },
      { name: 'reminder-settings', description: 'Reminder settings' },
      { name: 'detection-logs', description: 'Detection logs' },
      { name: 'email-history', description: 'Email history' }
    ];

    return createSuccessResponse(200, { resources });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetUsers(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'USER'
        }
      })
    );

    return createSuccessResponse(200, { users: result.Items || [] });
  } catch (error) {
    console.error('Error getting users:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetUser(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return createErrorResponse(400, 'User ID is required');
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `USER#${userId}`,
          sk: 'PROFILE'
        }
      })
    );

    if (!result.Item) {
      return createErrorResponse(404, 'User not found');
    }

    return createSuccessResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting user:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateUser(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.username || !body.email || !body.fullName || !body.role || !body.status) {
      return createErrorResponse(400, 'Missing required fields');
    }

    const userId = randomUUID();
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
      status: body.status,
      createdAt: now,
      updatedAt: now,
      createdBy: auth.userId
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: user
      })
    );

    await createAuditLog('CREATE', auth.userId, 'USER', userId, { user });

    return createSuccessResponse(201, user);
  } catch (error) {
    console.error('Error creating user:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateUser(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return createErrorResponse(400, 'User ID is required');
    }

    const body = JSON.parse(event.body || '{}');
    const now = Date.now();

    const updateExpression = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.username) {
      updateExpression.push('username = :username');
      expressionAttributeValues[':username'] = body.username;
    }
    if (body.email) {
      updateExpression.push('email = :email');
      expressionAttributeValues[':email'] = body.email;
    }
    if (body.fullName) {
      updateExpression.push('fullName = :fullName');
      expressionAttributeValues[':fullName'] = body.fullName;
    }
    if (body.department) {
      updateExpression.push('department = :department');
      expressionAttributeValues[':department'] = body.department;
    }
    if (body.role) {
      updateExpression.push('role = :role');
      expressionAttributeValues[':role'] = body.role;
    }
    if (body.status) {
      updateExpression.push('status = :status');
      expressionAttributeValues[':status'] = body.status;
    }

    updateExpression.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = now;

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `USER#${userId}`,
          sk: 'PROFILE'
        },
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    await createAuditLog('UPDATE', auth.userId, 'USER', userId, { changes: body });

    return createSuccessResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating user:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteUser(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.pathParameters?.id;
    if (!userId) {
      return createErrorResponse(400, 'User ID is required');
    }

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `USER#${userId}`,
          sk: 'PROFILE'
        }
      })
    );

    await createAuditLog('DELETE', auth.userId, 'USER', userId, {});

    return createSuccessResponse(204, {});
  } catch (error) {
    console.error('Error deleting user:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetDailyReports(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'REPORT'
        }
      })
    );

    return createSuccessResponse(200, { reports: result.Items || [] });
  } catch (error) {
    console.error('Error getting daily reports:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetDailyReport(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    if (!reportId) {
      return createErrorResponse(400, 'Report ID is required');
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `REPORT#${reportId}`,
          sk: 'DATA'
        }
      })
    );

    if (!result.Item) {
      return createErrorResponse(404, 'Report not found');
    }

    return createSuccessResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting daily report:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateDailyReport(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.userId || !body.reportDate || !body.workContent) {
      return createErrorResponse(400, 'Missing required fields');
    }

    const reportId = randomUUID();
    const now = Date.now();

    const report: DailyReport = {
      pk: `REPORT#${reportId}`,
      sk: 'DATA',
      reportId,
      userId: body.userId,
      reportDate: body.reportDate,
      workContent: body.workContent,
      achievements: body.achievements,
      issues: body.issues,
      tomorrowPlan: body.tomorrowPlan,
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: report
      })
    );

    await createAuditLog('CREATE', auth.userId, 'REPORT', reportId, { report });

    return createSuccessResponse(201, report);
  } catch (error) {
    console.error('Error creating daily report:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateDailyReport(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    if (!reportId) {
      return createErrorResponse(400, 'Report ID is required');
    }

    const body = JSON.parse(event.body || '{}');
    const now = Date.now();

    const updateExpression = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.workContent) {
      updateExpression.push('workContent = :workContent');
      expressionAttributeValues[':workContent'] = body.workContent;
    }
    if (body.achievements) {
      updateExpression.push('achievements = :achievements');
      expressionAttributeValues[':achievements'] = body.achievements;
    }
    if (body.issues) {
      updateExpression.push('issues = :issues');
      expressionAttributeValues[':issues'] = body.issues;
    }
    if (body.tomorrowPlan) {
      updateExpression.push('tomorrowPlan = :tomorrowPlan');
      expressionAttributeValues[':tomorrowPlan'] = body.tomorrowPlan;
    }

    updateExpression.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = now;

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `REPORT#${reportId}`,
          sk: 'DATA'
        },
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    await createAuditLog('UPDATE', auth.userId, 'REPORT', reportId, { changes: body });

    return createSuccessResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating daily report:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteDailyReport(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const reportId = event.pathParameters?.id;
    if (!reportId) {
      return createErrorResponse(400, 'Report ID is required');
    }

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `REPORT#${reportId}`,
          sk: 'DATA'
        }
      })
    );

    await createAuditLog('DELETE', auth.userId, 'REPORT', reportId, {});

    return createSuccessResponse(204, {});
  } catch (error) {
    console.error('Error deleting daily report:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetReminderSettings(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'REMINDER'
        }
      })
    );

    return createSuccessResponse(200, { settings: result.Items || [] });
  } catch (error) {
    console.error('Error getting reminder settings:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetReminderSetting(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    if (!reminderId) {
      return createErrorResponse(400, 'Reminder ID is required');
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `REMINDER#${reminderId}`,
          sk: 'CONFIG'
        }
      })
    );

    if (!result.Item) {
      return createErrorResponse(404, 'Reminder setting not found');
    }

    return createSuccessResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting reminder setting:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateReminderSetting(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.userId || body.enabled === undefined || !body.sendTime || !body.sendMethod) {
      return createErrorResponse(400, 'Missing required fields');
    }

    const reminderId = randomUUID();
    const now = Date.now();

    const setting: ReminderSetting = {
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
        TableName: TABLE_NAME,
        Item: setting
      })
    );

    await createAuditLog('CREATE', auth.userId, 'REMINDER', reminderId, { setting });

    return createSuccessResponse(201, setting);
  } catch (error) {
    console.error('Error creating reminder setting:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateReminderSetting(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    if (!reminderId) {
      return createErrorResponse(400, 'Reminder ID is required');
    }

    const body = JSON.parse(event.body || '{}');
    const now = Date.now();

    const updateExpression = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.enabled !== undefined) {
      updateExpression.push('enabled = :enabled');
      expressionAttributeValues[':enabled'] = body.enabled;
    }
    if (body.sendTime) {
      updateExpression.push('sendTime = :sendTime');
      expressionAttributeValues[':sendTime'] = body.sendTime;
    }
    if (body.sendDays) {
      updateExpression.push('sendDays = :sendDays');
      expressionAttributeValues[':sendDays'] = body.sendDays;
    }
    if (body.sendMethod) {
      updateExpression.push('sendMethod = :sendMethod');
      expressionAttributeValues[':sendMethod'] = body.sendMethod;
    }

    updateExpression.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = now;

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `REMINDER#${reminderId}`,
          sk: 'CONFIG'
        },
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    await createAuditLog('UPDATE', auth.userId, 'REMINDER', reminderId, { changes: body });

    return createSuccessResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating reminder setting:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteReminderSetting(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const reminderId = event.pathParameters?.id;
    if (!reminderId) {
      return createErrorResponse(400, 'Reminder ID is required');
    }

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `REMINDER#${reminderId}`,
          sk: 'CONFIG'
        }
      })
    );

    await createAuditLog('DELETE', auth.userId, 'REMINDER', reminderId, {});

    return createSuccessResponse(204, {});
  } catch (error) {
    console.error('Error deleting reminder setting:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetDetectionLogs(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'DETECTION'
        }
      })
    );

    return createSuccessResponse(200, { logs: result.Items || [] });
  } catch (error) {
    console.error('Error getting detection logs:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetDetectionLog(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    if (!logId) {
      return createErrorResponse(400, 'Log ID is required');
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `DETECTION#${logId}`,
          sk: 'LOG'
        }
      })
    );

    if (!result.Item) {
      return createErrorResponse(404, 'Detection log not found');
    }

    return createSuccessResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting detection log:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateDetectionLog(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.userId || !body.targetDate || !body.submissionStatus || body.reminderSent === undefined) {
      return createErrorResponse(400, 'Missing required fields');
    }

    const logId = randomUUID();
    const now = Date.now();

    const log: DetectionLog = {
      pk: `DETECTION#${logId}`,
      sk: 'LOG',
      logId,
      userId: body.userId,
      targetDate: body.targetDate,
      detectedAt: now,
      reminderSent: body.reminderSent,
      reminderSentAt: body.reminderSentAt,
      submissionStatus: body.submissionStatus,
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: log
      })
    );

    await createAuditLog('CREATE', auth.userId, 'DETECTION', logId, { log });

    return createSuccessResponse(201, log);
  } catch (error) {
    console.error('Error creating detection log:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateDetectionLog(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    if (!logId) {
      return createErrorResponse(400, 'Log ID is required');
    }

    const body = JSON.parse(event.body || '{}');
    const now = Date.now();

    const updateExpression = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.reminderSent !== undefined) {
      updateExpression.push('reminderSent = :reminderSent');
      expressionAttributeValues[':reminderSent'] = body.reminderSent;
    }
    if (body.reminderSentAt) {
      updateExpression.push('reminderSentAt = :reminderSentAt');
      expressionAttributeValues[':reminderSentAt'] = body.reminderSentAt;
    }
    if (body.submissionStatus) {
      updateExpression.push('submissionStatus = :submissionStatus');
      expressionAttributeValues[':submissionStatus'] = body.submissionStatus;
    }

    updateExpression.push('updatedAt = :updatedAt');
    expressionAttributeValues[':updatedAt'] = now;

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `DETECTION#${logId}`,
          sk: 'LOG'
        },
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    await createAuditLog('UPDATE', auth.userId, 'DETECTION', logId, { changes: body });

    return createSuccessResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating detection log:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteDetectionLog(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const logId = event.pathParameters?.id;
    if (!logId) {
      return createErrorResponse(400, 'Log ID is required');
    }

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `DETECTION#${logId}`,
          sk: 'LOG'
        }
      })
    );

    await createAuditLog('DELETE', auth.userId, 'DETECTION', logId, {});

    return createSuccessResponse(204, {});
  } catch (error) {
    console.error('Error deleting detection log:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetEmailHistory(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'EMAIL'
        }
      })
    );

    return createSuccessResponse(200, { history: result.Items || [] });
  } catch (error) {
    console.error('Error getting email history:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetEmailHistoryItem(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    if (!emailId) {
      return createErrorResponse(400, 'Email ID is required');
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `EMAIL#${emailId}`,
          sk: 'RECORD'
        }
      })
    );

    if (!result.Item) {
      return createErrorResponse(404, 'Email history not found');
    }

    return createSuccessResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting email history item:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateEmailHistory(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const body = JSON.parse(event.body || '{}');

    if (!body.userId || !body.emailType || !body.toAddress || !body.subject || !body.body || !body.status) {
      return createErrorResponse(400, 'Missing required fields');
    }

    const emailId = randomUUID();
    const now = Date.now();

    const email: EmailHistory = {
      pk: `EMAIL#${emailId}`,
      sk: 'RECORD',
      emailId,
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
      retryFlag: body.retryFlag || false,
      createdAt: now
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: email
      })
    );

    await createAuditLog('CREATE', auth.userId, 'EMAIL', emailId, { email });

    return createSuccessResponse(201, email);
  } catch (error) {
    console.error('Error creating email history:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateEmailHistory(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    if (!emailId) {
      return createErrorResponse(400, 'Email ID is required');
    }

    const body = JSON.parse(event.body || '{}');

    const updateExpression = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    if (body.status) {
      updateExpression.push('status = :status');
      expressionAttributeValues[':status'] = body.status;
    }
    if (body.errorMessage) {
      updateExpression.push('errorMessage = :errorMessage');
      expressionAttributeValues[':errorMessage'] = body.errorMessage;
    }
    if (body.retryFlag !== undefined) {
      updateExpression.push('retryFlag = :retryFlag');
      expressionAttributeValues[':retryFlag'] = body.retryFlag;
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `EMAIL#${emailId}`,
          sk: 'RECORD'
        },
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    await createAuditLog('UPDATE', auth.userId, 'EMAIL', emailId, { changes: body });

    return createSuccessResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating email history:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteEmailHistory(
  event: APIGatewayProxyEvent,
  auth: AuthContext
): Promise<APIGatewayProxyResult> {
  try {
    const emailId = event.pathParameters?.id;
    if (!emailId) {
      return createErrorResponse(400, 'Email ID is required');
    }

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `EMAIL#${emailId}`,
          sk: 'RECORD'
        }
      })
    );

    await createAuditLog('DELETE', auth.userId, 'EMAIL', emailId, {});

    return createSuccessResponse(204, {});
  } catch (error) {
    console.error('Error deleting email history:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

interface BulkItem {
  [key: string]: unknown;
}

const tableConfigs = [
  { prefix: 'USER', sk: 'PROFILE' },
  { prefix: 'REPORT', sk: 'DATA' },
  { prefix: 'REMINDER', sk: 'CONFIG' },
  { prefix: 'DETECTION', sk: 'LOG' },
  { prefix: 'EMAIL', sk: 'RECORD' }
];

async function handleBulkImport(
  event: APIGatewayProxyEvent,
  auth: AuthContext,
  tableIndex: number
): Promise<APIGatewayProxyResult> {
  try {
    if (tableIndex < 0 || tableIndex >= tableConfigs.length) {
      return createErrorResponse(400, 'Invalid table index');
    }

    const body = JSON.parse(event.body || '{}');
    const items = body.items as BulkItem[];

    if (!Array.isArray(items) || items.length === 0) {
      return createErrorResponse(400, 'Items array is required and must not be empty');
    }

    const config = tableConfigs[tableIndex];
    const now = Date.now();
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    const processedItems = items.map((item) => ({
      ...item,
      id: item.id || randomUUID(),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now
    }));

    for (let i = 0; i < processedItems.length; i += 25) {
      const batch = processedItems.slice(i, i + 25);
      const requestItems: Record<string, unknown>[] = [];

      for (const item of batch) {
        try {
          const id = item.id as string;
          const dynamoItem = {
            pk: `${config.prefix}#${id}`,
            sk: config.sk,
            ...item
          };

          requestItems.push({
            PutRequest: {
              Item: dynamoItem
            }
          });
        } catch (error) {
          failed++;
          errors.push(`Failed to process item: ${(error as Error).message}`);
        }
      }

      if (requestItems.length > 0) {
        try {
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: requestItems
              }
            })
          );
          imported += requestItems.length;
        } catch (error) {
          failed += requestItems.length;
          errors.push(`Batch write failed: ${(error as Error).message}`);
        }
      }
    }

    await createAuditLog('BULK_IMPORT', auth.userId, config.prefix, 'BULK', {
      imported,
      failed,
      totalItems: items.length
    });

    return createSuccessResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const path = event.path || '';
  const method = event.httpMethod || 'GET';
  const endpoint = `${method} ${path}`;

  const auth = extractAuthContext(event);
  if (!auth) {
    return createErrorResponse(401, 'Unauthorized');
  }

  if (!checkPermission(endpoint, auth.role)) {
    return createErrorResponse(403, 'Forbidden');
  }

  try {
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event, auth);
    }

    if (method === 'GET' && path === '/users') {
      return await handleGetUsers(event, auth);
    }

    if (method === 'GET' && path.match(/^\/users\/[^/]+$/)) {
      return await handleGetUser(event, auth);
    }

    if (method === 'POST' && path === '/users') {
      return await handleCreateUser(event, auth);
    }

    if (method === 'PUT' && path.match(/^\/users\/[^/]+$/)) {
      return await handleUpdateUser(event, auth);
    }

    if (method === 'DELETE' && path.match(/^\/users\/[^/]+$/)) {
      return await handleDeleteUser(event, auth);
    }

    if (method === 'GET' && path === '/daily-reports') {
      return await handleGetDailyReports(event, auth);
    }

    if (method === 'GET' && path.match(/^\/daily-reports\/[^/]+$/)) {
      return await handleGetDailyReport(event, auth);
    }

    if (method === 'POST' && path === '/daily-reports') {
      return await handleCreateDailyReport(event, auth);
    }

    if (method === 'PUT' && path.match(/^\/daily-reports\/[^/]+$/)) {
      return await handleUpdateDailyReport(event, auth);
    }

    if (method === 'DELETE' && path.match(/^\/daily-reports\/[^/]+$/)) {
      return await handleDeleteDailyReport(event, auth);
    }

    if (method === 'GET' && path === '/reminder-settings') {
      return await handleGetReminderSettings(event, auth);
    }

    if (method === 'GET' && path.match(/^\/reminder-settings\/[^/]+$/)) {
      return await handleGetReminderSetting(event, auth);
    }

    if (method === 'POST' && path === '/reminder-settings') {
      return await handleCreateReminderSetting(event, auth);
    }

    if (method === 'PUT' && path.match(/^\/reminder-settings\/[^/]+$/)) {
      return await handleUpdateReminderSetting(event, auth);
    }

    if (method === 'DELETE' && path.match(/^\/reminder-settings\/[^/]+$/)) {
      return await handleDeleteReminderSetting(event, auth);
    }

    if (method === 'GET' && path === '/detection-logs') {
      return await handleGetDetectionLogs(event, auth);
    }

    if (method === 'GET' && path.match(/^\/detection-logs\/[^/]+$/)) {
      return await handleGetDetectionLog(event, auth);
    }

    if (method === 'POST' && path === '/detection-logs') {
      return await handleCreateDetectionLog(event, auth);
    }

    if (method === 'PUT' && path.match(/^\/detection-logs\/[^/]+$/)) {
      return await handleUpdateDetectionLog(event, auth);
    }

    if (method === 'DELETE' && path.match(/^\/detection-logs\/[^/]+$/)) {
      return await handleDeleteDetectionLog(event, auth);
    }

    if (method === 'GET' && path === '/email-history') {
      return await handleGetEmailHistory(event, auth);
    }

    if (method === 'GET' && path.match(/^\/email-history\/[^/]+$/)) {
      return await handleGetEmailHistoryItem(event, auth);
    }

    if (method === 'POST' && path === '/email-history') {
      return await handleCreateEmailHistory(event, auth);
    }

    if (method === 'PUT' && path.match(/^\/email-history\/[^/]+$/)) {
      return await handleUpdateEmailHistory(event, auth);
    }

    if (method === 'DELETE' && path.match(/^\/email-history\/[^/]+$/)) {
      return await handleDeleteEmailHistory(event, auth);
    }

    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (method === 'POST' && bulkMatch) {
      const tableIndex = parseInt(bulkMatch[1], 10);
      return await handleBulkImport(event, auth, tableIndex);
    }

    return createErrorResponse(404, 'Not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
};