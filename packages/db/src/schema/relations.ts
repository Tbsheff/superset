import { relations } from "drizzle-orm";

import { users } from "./auth";
import {
	githubInstallations,
	githubPullRequests,
	githubRepositories,
} from "./github";
import {
	agentCommands,
	chatSessions,
	devicePresence,
	integrationConnections,
	projects,
	sandboxImages,
	secrets,
	sessionHosts,
	taskStatuses,
	tasks,
	usersSlackUsers,
	workspaces,
} from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
	createdTasks: many(tasks, { relationName: "creator" }),
	assignedTasks: many(tasks, { relationName: "assignee" }),
	connectedIntegrations: many(integrationConnections),
	githubInstallations: many(githubInstallations),
	devicePresence: many(devicePresence),
	agentCommands: many(agentCommands),
	chatSessions: many(chatSessions),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
	status: one(taskStatuses, {
		fields: [tasks.statusId],
		references: [taskStatuses.id],
	}),
	assignee: one(users, {
		fields: [tasks.assigneeId],
		references: [users.id],
		relationName: "assignee",
	}),
	creator: one(users, {
		fields: [tasks.creatorId],
		references: [users.id],
		relationName: "creator",
	}),
}));

export const taskStatusesRelations = relations(taskStatuses, ({ many }) => ({
	tasks: many(tasks),
}));

export const integrationConnectionsRelations = relations(
	integrationConnections,
	({ one }) => ({
		connectedBy: one(users, {
			fields: [integrationConnections.connectedByUserId],
			references: [users.id],
		}),
	}),
);

// GitHub relations
export const githubInstallationsRelations = relations(
	githubInstallations,
	({ one, many }) => ({
		connectedBy: one(users, {
			fields: [githubInstallations.connectedByUserId],
			references: [users.id],
		}),
		repositories: many(githubRepositories),
	}),
);

export const githubRepositoriesRelations = relations(
	githubRepositories,
	({ one, many }) => ({
		installation: one(githubInstallations, {
			fields: [githubRepositories.installationId],
			references: [githubInstallations.id],
		}),
		pullRequests: many(githubPullRequests),
		projects: many(projects),
	}),
);

export const githubPullRequestsRelations = relations(
	githubPullRequests,
	({ one }) => ({
		repository: one(githubRepositories, {
			fields: [githubPullRequests.repositoryId],
			references: [githubRepositories.id],
		}),
	}),
);

// Agent relations
export const devicePresenceRelations = relations(devicePresence, ({ one }) => ({
	user: one(users, {
		fields: [devicePresence.userId],
		references: [users.id],
	}),
}));

export const agentCommandsRelations = relations(agentCommands, ({ one }) => ({
	user: one(users, {
		fields: [agentCommands.userId],
		references: [users.id],
	}),
	parentCommand: one(agentCommands, {
		fields: [agentCommands.parentCommandId],
		references: [agentCommands.id],
		relationName: "parentCommand",
	}),
}));

export const usersSlackUsersRelations = relations(
	usersSlackUsers,
	({ one }) => ({
		user: one(users, {
			fields: [usersSlackUsers.userId],
			references: [users.id],
		}),
	}),
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
	githubRepository: one(githubRepositories, {
		fields: [projects.githubRepositoryId],
		references: [githubRepositories.id],
	}),
	secrets: many(secrets),
	sandboxImage: one(sandboxImages),
	workspaces: many(workspaces),
}));

export const secretsRelations = relations(secrets, ({ one }) => ({
	project: one(projects, {
		fields: [secrets.projectId],
		references: [projects.id],
	}),
	createdBy: one(users, {
		fields: [secrets.createdByUserId],
		references: [users.id],
	}),
}));

export const sandboxImagesRelations = relations(sandboxImages, ({ one }) => ({
	project: one(projects, {
		fields: [sandboxImages.projectId],
		references: [projects.id],
	}),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
	project: one(projects, {
		fields: [workspaces.projectId],
		references: [projects.id],
	}),
	createdBy: one(users, {
		fields: [workspaces.createdByUserId],
		references: [users.id],
	}),
	chatSessions: many(chatSessions),
}));

export const chatSessionsRelations = relations(
	chatSessions,
	({ one, many }) => ({
		createdBy: one(users, {
			fields: [chatSessions.createdBy],
			references: [users.id],
		}),
		workspace: one(workspaces, {
			fields: [chatSessions.workspaceId],
			references: [workspaces.id],
		}),
		sessionHosts: many(sessionHosts),
	}),
);

export const sessionHostsRelations = relations(sessionHosts, ({ one }) => ({
	chatSession: one(chatSessions, {
		fields: [sessionHosts.sessionId],
		references: [chatSessions.id],
	}),
}));
