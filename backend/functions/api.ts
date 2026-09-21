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
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import {
  extractAuthContext,
  checkPermission,
  createUnauthorizedResponse,
  createBadRequestResponse,
  createNotFoundResponse,
  createInternalErrorResponse,
  createSuccessResponse,
} from './rbac';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.MAIN_TABLE || 'daily-report-system';

interface User {
  pk: string;
  sk: string;
  userId: string;
  userName: string;
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
    timestamp: Date.now(),
  };
}

async function getUser(userId: string): Promise<User | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: 'USER', sk: userId },
      })
    );
    return result.Item as User | undefined || null;
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  }
}

async function listUsers(): Promise<User[]> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: { ':pk': 'USER' },
      })
    );
    return (result.Items as User[]) || [];
  } catch (error) {
    console.error('Error listing users:', error);
    return [];
  }
}

async function createUser(user: Omit<User, 'pk' | 'sk' | 'createdAt' | 'updatedAt'>, userId: string): Promise<User> {
  const now = Date.now();
  const newUser: User = {
    pk: 'USER',
    sk: user.userId,
    ...user,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: newUser,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('CREATE', 'USER', user.userId, userId, newUser),
    })
  );

  return newUser;
}

async function updateUser(userId: string, updates: Partial<User>, requestUserId: string): Promise<User | null> {
  const now = Date.now();
  const user = await getUser(userId);
  if (!user) return null;

  const updatedUser = { ...user, ...updates, updatedAt: now };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: updatedUser,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('UPDATE', 'USER', userId, requestUserId, updates),
    })
  );

  return updatedUser;
}

async function deleteUser(userId: string, requestUserId: string): Promise<boolean> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: 'USER', sk: userId },
      })
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: createAuditLog('DELETE', 'USER', userId, requestUserId, {}),
      })
    );

    return true;
  } catch (error) {
    console.error('Error deleting user:', error);
    return false;
  }
}

async function getDailyReport(reportId: string): Promise<DailyReport | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: 'REPORT', sk: reportId },
      })
    );
    return result.Item as DailyReport | undefined || null;
  } catch (error) {
    console.error('Error getting daily report:', error);
    return null;
  }
}

async function listDailyReports(): Promise<DailyReport[]> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: { ':pk': 'REPORT' },
      })
    );
    return (result.Items as DailyReport[]) || [];
  } catch (error) {
    console.error('Error listing daily reports:', error);
    return [];
  }
}

async function createDailyReport(
  report: Omit<DailyReport, 'pk' | 'sk' | 'createdAt' | 'updatedAt'>,
  userId: string
): Promise<DailyReport> {
  const now = Date.now();
  const newReport: DailyReport = {
    pk: 'REPORT',
    sk: report.reportId,
    ...report,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: newReport,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('CREATE', 'REPORT', report.reportId, userId, newReport),
    })
  );

  return newReport;
}

async function updateDailyReport(
  reportId: string,
  updates: Partial<DailyReport>,
  requestUserId: string
): Promise<DailyReport | null> {
  const now = Date.now();
  const report = await getDailyReport(reportId);
  if (!report) return null;

  const updatedReport = { ...report, ...updates, updatedAt: now };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: updatedReport,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('UPDATE', 'REPORT', reportId, requestUserId, updates),
    })
  );

  return updatedReport;
}

async function deleteDailyReport(reportId: string, requestUserId: string): Promise<boolean> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: 'REPORT', sk: reportId },
      })
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: createAuditLog('DELETE', 'REPORT', reportId, requestUserId, {}),
      })
    );

    return true;
  } catch (error) {
    console.error('Error deleting daily report:', error);
    return false;
  }
}

async function getReminder(reminderId: string): Promise<ReminderSetting | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: 'REMINDER', sk: reminderId },
      })
    );
    return result.Item as ReminderSetting | undefined || null;
  } catch (error) {
    console.error('Error getting reminder:', error);
    return null;
  }
}

async function listReminders(): Promise<ReminderSetting[]> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: { ':pk': 'REMINDER' },
      })
    );
    return (result.Items as ReminderSetting[]) || [];
  } catch (error) {
    console.error('Error listing reminders:', error);
    return [];
  }
}

async function createReminder(
  reminder: Omit<ReminderSetting, 'pk' | 'sk' | 'createdAt' | 'updatedAt'>,
  userId: string
): Promise<ReminderSetting> {
  const now = Date.now();
  const newReminder: ReminderSetting = {
    pk: 'REMINDER',
    sk: reminder.reminderId,
    ...reminder,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: newReminder,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('CREATE', 'REMINDER', reminder.reminderId, userId, newReminder),
    })
  );

  return newReminder;
}

async function updateReminder(
  reminderId: string,
  updates: Partial<ReminderSetting>,
  requestUserId: string
): Promise<ReminderSetting | null> {
  const now = Date.now();
  const reminder = await getReminder(reminderId);
  if (!reminder) return null;

  const updatedReminder = { ...reminder, ...updates, updatedAt: now };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: updatedReminder,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('UPDATE', 'REMINDER', reminderId, requestUserId, updates),
    })
  );

  return updatedReminder;
}

async function deleteReminder(reminderId: string, requestUserId: string): Promise<boolean> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: 'REMINDER', sk: reminderId },
      })
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: createAuditLog('DELETE', 'REMINDER', reminderId, requestUserId, {}),
      })
    );

    return true;
  } catch (error) {
    console.error('Error deleting reminder:', error);
    return false;
  }
}

async function getDetectionLog(logId: string): Promise<DetectionLog | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: 'DETECTION', sk: logId },
      })
    );
    return result.Item as DetectionLog | undefined || null;
  } catch (error) {
    console.error('Error getting detection log:', error);
    return null;
  }
}

async function listDetectionLogs(): Promise<DetectionLog[]> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: { ':pk': 'DETECTION' },
      })
    );
    return (result.Items as DetectionLog[]) || [];
  } catch (error) {
    console.error('Error listing detection logs:', error);
    return [];
  }
}

async function createDetectionLog(
  log: Omit<DetectionLog, 'pk' | 'sk' | 'createdAt' | 'updatedAt'>,
  userId: string
): Promise<DetectionLog> {
  const now = Date.now();
  const newLog: DetectionLog = {
    pk: 'DETECTION',
    sk: log.logId,
    ...log,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: newLog,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('CREATE', 'DETECTION', log.logId, userId, newLog),
    })
  );

  return newLog;
}

async function updateDetectionLog(
  logId: string,
  updates: Partial<DetectionLog>,
  requestUserId: string
): Promise<DetectionLog | null> {
  const now = Date.now();
  const log = await getDetectionLog(logId);
  if (!log) return null;

  const updatedLog = { ...log, ...updates, updatedAt: now };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: updatedLog,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('UPDATE', 'DETECTION', logId, requestUserId, updates),
    })
  );

  return updatedLog;
}

async function deleteDetectionLog(logId: string, requestUserId: string): Promise<boolean> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: 'DETECTION', sk: logId },
      })
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: createAuditLog('DELETE', 'DETECTION', logId, requestUserId, {}),
      })
    );

    return true;
  } catch (error) {
    console.error('Error deleting detection log:', error);
    return false;
  }
}

async function getEmailHistory(emailId: string): Promise<EmailHistory | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: 'EMAIL', sk: emailId },
      })
    );
    return result.Item as EmailHistory | undefined || null;
  } catch (error) {
    console.error('Error getting email history:', error);
    return null;
  }
}

async function listEmailHistory(): Promise<EmailHistory[]> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :pk)',
        ExpressionAttributeValues: { ':pk': 'EMAIL' },
      })
    );
    return (result.Items as EmailHistory[]) || [];
  } catch (error) {
    console.error('Error listing email history:', error);
    return [];
  }
}

async function createEmailHistory(
  email: Omit<EmailHistory, 'pk' | 'sk' | 'createdAt'>,
  userId: string
): Promise<EmailHistory> {
  const now = Date.now();
  const newEmail: EmailHistory = {
    pk: 'EMAIL',
    sk: email.emailId,
    ...email,
    createdAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: newEmail,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('CREATE', 'EMAIL', email.emailId, userId, newEmail),
    })
  );

  return newEmail;
}

async function updateEmailHistory(
  emailId: string,
  updates: Partial<EmailHistory>,
  requestUserId: string
): Promise<EmailHistory | null> {
  const email = await getEmailHistory(emailId);
  if (!email) return null;

  const updatedEmail = { ...email, ...updates };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: updatedEmail,
    })
  );

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('UPDATE', 'EMAIL', emailId, requestUserId, updates),
    })
  );

  return updatedEmail;
}

async function deleteEmailHistory(emailId: string, requestUserId: string): Promise<boolean> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: 'EMAIL', sk: emailId },
      })
    );

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: createAuditLog('DELETE', 'EMAIL', emailId, requestUserId, {}),
      })
    );

    return true;
  } catch (error) {
    console.error('Error deleting email history:', error);
    return false;
  }
}

async function bulkWriteItems(
  items: Record<string, unknown>[],
  entityType: string,
  userId: string
): Promise<{ imported: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;
  let failed = 0;

  const now = Date.now();
  const processedItems = items.map((item) => ({
    ...item,
    id: (item.id as string) || randomUUID(),
    createdAt: now,
    updatedAt: now,
  }));

  const chunks = [];
  for (let i = 0; i < processedItems.length; i += 25) {
    chunks.push(processedItems.slice(i, i + 25));
  }

  for (const chunk of chunks) {
    try {
      const requests = chunk.map((item) => ({
        PutRequest: {
          Item: {
            pk: entityType,
            sk: (item.id as string) || randomUUID(),
            ...item,
          },
        },
      }));

      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: requests,
          },
        })
      );

      imported += chunk.length;
    } catch (error) {
      failed += chunk.length;
      errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: createAuditLog('BULK_CREATE', entityType, `bulk-${Date.now()}`, userId, {
        imported,
        failed,
        itemCount: items.length,
      }),
    })
  );

  return { imported, failed, errors };
}

async function handleGetResources(): Promise<APIGatewayProxyResult> {
  try {
    const [users, reports, reminders, detectionLogs, emailHistory] = await Promise.all([
      listUsers(),
      listDailyReports(),
      listReminders(),
      listDetectionLogs(),
      listEmailHistory(),
    ]);

    return createSuccessResponse({
      users,
      reports,
      reminders,
      detectionLogs,
      emailHistory,
    });
  } catch (error) {
    console.error('Error in handleGetResources:', error);
    return createInternalErrorResponse('Failed to retrieve resources');
  }
}

async function handleGetUsers(): Promise<APIGatewayProxyResult> {
  try {
    const users = await listUsers();
    return createSuccessResponse(users);
  } catch (error) {
    console.error('Error in handleGetUsers:', error);
    return createInternalErrorResponse('Failed to retrieve users');
  }
}

async function handleGetUser(userId: string): Promise<APIGatewayProxyResult> {
  try {
    const user = await getUser(userId);
    if (!user) {
      return createNotFoundResponse('User not found');
    }
    return createSuccessResponse(user);
  } catch (error) {
    console.error('Error in handleGetUser:', error);
    return createInternalErrorResponse('Failed to retrieve user');
  }
}

async function handleCreateUser(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!body.userName || !body.email || !body.fullName || !body.role || !body.status) {
      return createBadRequestResponse('Missing required fields');
    }

    const userId = randomUUID();
    const user = await createUser(
      {
        userId,
        userName: body.userName as string,
        email: body.email as string,
        fullName: body.fullName as string,
        department: body.department as string | undefined,
        role: body.role as string,
        status: body.status as string,
        createdBy: requestUserId,
      },
      requestUserId
    );

    return createSuccessResponse(user, 201);
  } catch (error) {
    console.error('Error in handleCreateUser:', error);
    return createInternalErrorResponse('Failed to create user');
  }
}

async function handleUpdateUser(
  userId: string,
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    const user = await updateUser(userId, body as Partial<User>, requestUserId);
    if (!user) {
      return createNotFoundResponse('User not found');
    }
    return createSuccessResponse(user);
  } catch (error) {
    console.error('Error in handleUpdateUser:', error);
    return createInternalErrorResponse('Failed to update user');
  }
}

async function handleDeleteUser(userId: string, requestUserId: string): Promise<APIGatewayProxyResult> {
  try {
    const success = await deleteUser(userId, requestUserId);
    if (!success) {
      return createNotFoundResponse('User not found');
    }
    return createSuccessResponse({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteUser:', error);
    return createInternalErrorResponse('Failed to delete user');
  }
}

async function handleBulkCreateUsers(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!Array.isArray(body.items)) {
      return createBadRequestResponse('items must be an array');
    }

    const result = await bulkWriteItems(body.items, 'USER', requestUserId);
    return createSuccessResponse(result, 201);
  } catch (error) {
    console.error('Error in handleBulkCreateUsers:', error);
    return createInternalErrorResponse('Failed to bulk create users');
  }
}

async function handleGetDailyReports(): Promise<APIGatewayProxyResult> {
  try {
    const reports = await listDailyReports();
    return createSuccessResponse(reports);
  } catch (error) {
    console.error('Error in handleGetDailyReports:', error);
    return createInternalErrorResponse('Failed to retrieve daily reports');
  }
}

async function handleGetDailyReport(reportId: string): Promise<APIGatewayProxyResult> {
  try {
    const report = await getDailyReport(reportId);
    if (!report) {
      return createNotFoundResponse('Daily report not found');
    }
    return createSuccessResponse(report);
  } catch (error) {
    console.error('Error in handleGetDailyReport:', error);
    return createInternalErrorResponse('Failed to retrieve daily report');
  }
}

async function handleCreateDailyReport(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!body.userId || !body.reportDate || !body.taskContent) {
      return createBadRequestResponse('Missing required fields');
    }

    const reportId = randomUUID();
    const report = await createDailyReport(
      {
        reportId,
        userId: body.userId as string,
        reportDate: body.reportDate as number,
        taskContent: body.taskContent as string,
        achievements: body.achievements as string | undefined,
        issues: body.issues as string | undefined,
        tomorrowPlan: body.tomorrowPlan as string | undefined,
      },
      requestUserId
    );

    return createSuccessResponse(report, 201);
  } catch (error) {
    console.error('Error in handleCreateDailyReport:', error);
    return createInternalErrorResponse('Failed to create daily report');
  }
}

async function handleUpdateDailyReport(
  reportId: string,
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    const report = await updateDailyReport(reportId, body as Partial<DailyReport>, requestUserId);
    if (!report) {
      return createNotFoundResponse('Daily report not found');
    }
    return createSuccessResponse(report);
  } catch (error) {
    console.error('Error in handleUpdateDailyReport:', error);
    return createInternalErrorResponse('Failed to update daily report');
  }
}

async function handleDeleteDailyReport(reportId: string, requestUserId: string): Promise<APIGatewayProxyResult> {
  try {
    const success = await deleteDailyReport(reportId, requestUserId);
    if (!success) {
      return createNotFoundResponse('Daily report not found');
    }
    return createSuccessResponse({ message: 'Daily report deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteDailyReport:', error);
    return createInternalErrorResponse('Failed to delete daily report');
  }
}

async function handleBulkCreateDailyReports(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!Array.isArray(body.items)) {
      return createBadRequestResponse('items must be an array');
    }

    const result = await bulkWriteItems(body.items, 'REPORT', requestUserId);
    return createSuccessResponse(result, 201);
  } catch (error) {
    console.error('Error in handleBulkCreateDailyReports:', error);
    return createInternalErrorResponse('Failed to bulk create daily reports');
  }
}

async function handleGetReminders(): Promise<APIGatewayProxyResult> {
  try {
    const reminders = await listReminders();
    return createSuccessResponse(reminders);
  } catch (error) {
    console.error('Error in handleGetReminders:', error);
    return createInternalErrorResponse('Failed to retrieve reminders');
  }
}

async function handleGetReminder(reminderId: string): Promise<APIGatewayProxyResult> {
  try {
    const reminder = await getReminder(reminderId);
    if (!reminder) {
      return createNotFoundResponse('Reminder not found');
    }
    return createSuccessResponse(reminder);
  } catch (error) {
    console.error('Error in handleGetReminder:', error);
    return createInternalErrorResponse('Failed to retrieve reminder');
  }
}

async function handleCreateReminder(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!body.userId || !body.sendTime || !body.sendMethod) {
      return createBadRequestResponse('Missing required fields');
    }

    const reminderId = randomUUID();
    const reminder = await createReminder(
      {
        reminderId,
        userId: body.userId as string,
        enabled: (body.enabled as boolean) || true,
        sendTime: body.sendTime as string,
        sendDays: body.sendDays as string | undefined,
        sendMethod: body.sendMethod as string,
      },
      requestUserId
    );

    return createSuccessResponse(reminder, 201);
  } catch (error) {
    console.error('Error in handleCreateReminder:', error);
    return createInternalErrorResponse('Failed to create reminder');
  }
}

async function handleUpdateReminder(
  reminderId: string,
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    const reminder = await updateReminder(reminderId, body as Partial<ReminderSetting>, requestUserId);
    if (!reminder) {
      return createNotFoundResponse('Reminder not found');
    }
    return createSuccessResponse(reminder);
  } catch (error) {
    console.error('Error in handleUpdateReminder:', error);
    return createInternalErrorResponse('Failed to update reminder');
  }
}

async function handleDeleteReminder(reminderId: string, requestUserId: string): Promise<APIGatewayProxyResult> {
  try {
    const success = await deleteReminder(reminderId, requestUserId);
    if (!success) {
      return createNotFoundResponse('Reminder not found');
    }
    return createSuccessResponse({ message: 'Reminder deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteReminder:', error);
    return createInternalErrorResponse('Failed to delete reminder');
  }
}

async function handleBulkCreateReminders(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!Array.isArray(body.items)) {
      return createBadRequestResponse('items must be an array');
    }

    const result = await bulkWriteItems(body.items, 'REMINDER', requestUserId);
    return createSuccessResponse(result, 201);
  } catch (error) {
    console.error('Error in handleBulkCreateReminders:', error);
    return createInternalErrorResponse('Failed to bulk create reminders');
  }
}

async function handleGetDetectionLogs(): Promise<APIGatewayProxyResult> {
  try {
    const logs = await listDetectionLogs();
    return createSuccessResponse(logs);
  } catch (error) {
    console.error('Error in handleGetDetectionLogs:', error);
    return createInternalErrorResponse('Failed to retrieve detection logs');
  }
}

async function handleGetDetectionLog(logId: string): Promise<APIGatewayProxyResult> {
  try {
    const log = await getDetectionLog(logId);
    if (!log) {
      return createNotFoundResponse('Detection log not found');
    }
    return createSuccessResponse(log);
  } catch (error) {
    console.error('Error in handleGetDetectionLog:', error);
    return createInternalErrorResponse('Failed to retrieve detection log');
  }
}

async function handleCreateDetectionLog(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!body.userId || !body.targetDate || !body.submissionStatus) {
      return createBadRequestResponse('Missing required fields');
    }

    const logId = randomUUID();
    const log = await createDetectionLog(
      {
        logId,
        userId: body.userId as string,
        targetDate: body.targetDate as number,
        detectedAt: Date.now(),
        reminderSent: (body.reminderSent as boolean) || false,
        reminderSentAt: body.reminderSentAt as number | undefined,
        submissionStatus: body.submissionStatus as string,
      },
      requestUserId
    );

    return createSuccessResponse(log, 201);
  } catch (error) {
    console.error('Error in handleCreateDetectionLog:', error);
    return createInternalErrorResponse('Failed to create detection log');
  }
}

async function handleUpdateDetectionLog(
  logId: string,
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    const log = await updateDetectionLog(logId, body as Partial<DetectionLog>, requestUserId);
    if (!log) {
      return createNotFoundResponse('Detection log not found');
    }
    return createSuccessResponse(log);
  } catch (error) {
    console.error('Error in handleUpdateDetectionLog:', error);
    return createInternalErrorResponse('Failed to update detection log');
  }
}

async function handleDeleteDetectionLog(logId: string, requestUserId: string): Promise<APIGatewayProxyResult> {
  try {
    const success = await deleteDetectionLog(logId, requestUserId);
    if (!success) {
      return createNotFoundResponse('Detection log not found');
    }
    return createSuccessResponse({ message: 'Detection log deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteDetectionLog:', error);
    return createInternalErrorResponse('Failed to delete detection log');
  }
}

async function handleBulkCreateDetectionLogs(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!Array.isArray(body.items)) {
      return createBadRequestResponse('items must be an array');
    }

    const result = await bulkWriteItems(body.items, 'DETECTION', requestUserId);
    return createSuccessResponse(result, 201);
  } catch (error) {
    console.error('Error in handleBulkCreateDetectionLogs:', error);
    return createInternalErrorResponse('Failed to bulk create detection logs');
  }
}

async function handleGetEmailHistory(): Promise<APIGatewayProxyResult> {
  try {
    const history = await listEmailHistory();
    return createSuccessResponse(history);
  } catch (error) {
    console.error('Error in handleGetEmailHistory:', error);
    return createInternalErrorResponse('Failed to retrieve email history');
  }
}

async function handleGetEmailHistoryItem(emailId: string): Promise<APIGatewayProxyResult> {
  try {
    const email = await getEmailHistory(emailId);
    if (!email) {
      return createNotFoundResponse('Email history not found');
    }
    return createSuccessResponse(email);
  } catch (error) {
    console.error('Error in handleGetEmailHistoryItem:', error);
    return createInternalErrorResponse('Failed to retrieve email history');
  }
}

async function handleCreateEmailHistory(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!body.userId || !body.emailType || !body.toAddress || !body.subject || !body.body || !body.status) {
      return createBadRequestResponse('Missing required fields');
    }

    const emailId = randomUUID();
    const email = await createEmailHistory(
      {
        emailId,
        userId: body.userId as string,
        emailType: body.emailType as string,
        toAddress: body.toAddress as string,
        subject: body.subject as string,
        body: body.body as string,
        sentAt: (body.sentAt as number) || Date.now(),
        status: body.status as string,
        errorMessage: body.errorMessage as string | undefined,
        relatedReportId: body.relatedReportId as string | undefined,
        relatedReminderId: body.relatedReminderId as string | undefined,
        retryFlag: (body.retryFlag as boolean) || false,
      },
      requestUserId
    );

    return createSuccessResponse(email, 201);
  } catch (error) {
    console.error('Error in handleCreateEmailHistory:', error);
    return createInternalErrorResponse('Failed to create email history');
  }
}

async function handleUpdateEmailHistory(
  emailId: string,
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    const email = await updateEmailHistory(emailId, body as Partial<EmailHistory>, requestUserId);
    if (!email) {
      return createNotFoundResponse('Email history not found');
    }
    return createSuccessResponse(email);
  } catch (error) {
    console.error('Error in handleUpdateEmailHistory:', error);
    return createInternalErrorResponse('Failed to update email history');
  }
}

async function handleDeleteEmailHistory(emailId: string, requestUserId: string): Promise<APIGatewayProxyResult> {
  try {
    const success = await deleteEmailHistory(emailId, requestUserId);
    if (!success) {
      return createNotFoundResponse('Email history not found');
    }
    return createSuccessResponse({ message: 'Email history deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteEmailHistory:', error);
    return createInternalErrorResponse('Failed to delete email history');
  }
}

async function handleBulkCreateEmailHistory(
  body: Record<string, unknown>,
  requestUserId: string
): Promise<APIGatewayProxyResult> {
  try {
    if (!Array.isArray(body.items)) {
      return createBadRequestResponse('items must be an array');
    }

    const result = await bulkWriteItems(body.items, 'EMAIL', requestUserId);
    return createSuccessResponse(result, 201);
  } catch (error) {
    console.error('Error in handleBulkCreateEmailHistory:', error);
    return createInternalErrorResponse('Failed to bulk create email history');
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const authContext = extractAuthContext(event);
    const method = event.httpMethod;
    const path = event.path;
    const body = event.body ? JSON.parse(event.body) : {};
    const pathParameters = event.pathParameters || {};

    if (!checkPermission(method, path, authContext.role)) {
      return createUnauthorizedResponse();
    }

    if (method === 'GET' && path === '/resources') {
      return await handleGetResources();
    }

    if (method === 'GET' && path === '/users') {
      return await handleGetUsers();
    }

    if (method === 'GET' && path.match(/^\/users\/[^/]+$/)) {
      const userId = pathParameters.id || '';
      return await handleGetUser(userId);
    }

    if (method === 'POST' && path === '/users') {
      return await handleCreateUser(body, authContext.userId);
    }

    if (method === 'PUT' && path.match(/^\/users\/[^/]+$/)) {
      const userId = pathParameters.id || '';
      return await handleUpdateUser(userId, body, authContext.userId);
    }

    if (method === 'DELETE' && path.match(/^\/users\/[^/]+$/)) {
      const userId = pathParameters.id || '';
      return await handleDeleteUser(userId, authContext.userId);
    }

    if (method === 'POST' && path === '/api/users/bulk') {
      return await handleBulkCreateUsers(body, authContext.userId);
    }

    if (method === 'GET' && path === '/daily-reports') {
      return await handleGetDailyReports();
    }

    if (method === 'GET' && path.match(/^\/daily-reports\/[^/]+$/)) {
      const reportId = pathParameters.id || '';
      return await handleGetDailyReport(reportId);
    }

    if (method === 'POST' && path === '/daily-reports') {
      return await handleCreateDailyReport(body, authContext.userId);
    }

    if (method === 'PUT' && path.match(/^\/daily-reports\/[^/]+$/)) {
      const reportId = pathParameters.id || '';
      return await handleUpdateDailyReport(reportId, body, authContext.userId);
    }

    if (method === 'DELETE' && path.match(/^\/daily-reports\/[^/]+$/)) {
      const reportId = pathParameters.id || '';
      return await handleDeleteDailyReport(reportId, authContext.userId);
    }

    if (method === 'POST' && path === '/api/daily-reports/bulk') {
      return await handleBulkCreateDailyReports(body, authContext.userId);
    }

    if (method === 'GET' && path === '/reminders') {
      return await handleGetReminders();
    }

    if (method === 'GET' && path.match(/^\/reminders\/[^/]+$/)) {
      const reminderId = pathParameters.id || '';
      return await handleGetReminder(reminderId);
    }

    if (method === 'POST' && path === '/reminders') {
      return await handleCreateReminder(body, authContext.userId);
    }

    if (method === 'PUT' && path.match(/^\/reminders\/[^/]+$/)) {
      const reminderId = pathParameters.id || '';
      return await handleUpdateReminder(reminderId, body, authContext.userId);
    }

    if (method === 'DELETE' && path.match(/^\/reminders\/[^/]+$/)) {
      const reminderId = pathParameters.id || '';
      return await handleDeleteReminder(reminderId, authContext.userId);
    }

    if (method === 'POST' && path === '/api/reminders/bulk') {
      return await handleBulkCreateReminders(body, authContext.userId);
    }

    if (method === 'GET' && path === '/detection-logs') {
      return await handleGetDetectionLogs();
    }

    if (method === 'GET' && path.match(/^\/detection-logs\/[^/]+$/)) {
      const logId = pathParameters.id || '';
      return await handleGetDetectionLog(logId);
    }

    if (method === 'POST' && path === '/detection-logs') {
      return await handleCreateDetectionLog(body, authContext.userId);
    }

    if (method === 'PUT' && path.match(/^\/detection-logs\/[^/]+$/)) {
      const logId = pathParameters.id || '';
      return await handleUpdateDetectionLog(logId, body, authContext.userId);
    }

    if (method === 'DELETE' && path.match(/^\/detection-logs\/[^/]+$/)) {
      const logId = pathParameters.id || '';
      return await handleDeleteDetectionLog(logId, authContext.userId);
    }

    if (method === 'POST' && path === '/api/detection-logs/bulk') {
      return await handleBulkCreateDetectionLogs(body, authContext.userId);
    }

    if (method === 'GET' && path === '/email-history') {
      return await handleGetEmailHistory();
    }

    if (method === 'GET' && path.match(/^\/email-history\/[^/]+$/)) {
      const emailId = pathParameters.id || '';
      return await handleGetEmailHistoryItem(emailId);
    }

    if (method === 'POST' && path === '/email-history') {
      return await handleCreateEmailHistory(body, authContext.userId);
    }

    if (method === 'PUT' && path.match(/^\/email-history\/[^/]+$/)) {
      const emailId = pathParameters.id || '';
      return await handleUpdateEmailHistory(emailId, body, authContext.userId);
    }

    if (method === 'DELETE' && path.match(/^\/email-history\/[^/]+$/)) {
      const emailId = pathParameters.id || '';
      return await handleDeleteEmailHistory(emailId, authContext.userId);
    }

    if (method === 'POST' && path === '/api/email-history/bulk') {
      return await handleBulkCreateEmailHistory(body, authContext.userId);
    }

    return createNotFoundResponse('Endpoint not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createInternalErrorResponse('Internal server error');
  }
};