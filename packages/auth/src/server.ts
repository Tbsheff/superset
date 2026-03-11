import { expo } from "@better-auth/expo";
import { oauthProvider } from "@better-auth/oauth-provider";
import { db } from "@superset/db/client";
import { members, subscriptions } from "@superset/db/schema";
import type { sessions } from "@superset/db/schema/auth";
import * as authSchema from "@superset/db/schema/auth";
import { canInvite, type OrganizationRole } from "@superset/shared/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	apiKey,
	bearer,
	customSession,
	organization,
} from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { and, desc, eq, sql } from "drizzle-orm";
import { env } from "./env";
import { acceptInvitationEndpoint } from "./lib/accept-invitation-endpoint";
import { generateMagicTokenForInvite } from "./lib/generate-magic-token";
import { invitationRateLimit } from "./lib/rate-limit";

const desktopDevPort = process.env.DESKTOP_VITE_PORT || "5173";
const desktopDevOrigins =
	process.env.NODE_ENV === "development"
		? [
				`http://localhost:${desktopDevPort}`,
				`http://127.0.0.1:${desktopDevPort}`,
			]
		: [];

export const auth = betterAuth({
	baseURL: env.NEXT_PUBLIC_API_URL,
	secret: env.BETTER_AUTH_SECRET,
	disabledPaths: [],
	database: drizzleAdapter(db, {
		provider: "sqlite",
		usePlural: true,
		schema: { ...authSchema, subscriptions },
	}),
	trustedOrigins: [
		env.NEXT_PUBLIC_WEB_URL,
		env.NEXT_PUBLIC_API_URL,
		env.NEXT_PUBLIC_MARKETING_URL,
		env.NEXT_PUBLIC_ADMIN_URL,
		...(env.NEXT_PUBLIC_DESKTOP_URL ? [env.NEXT_PUBLIC_DESKTOP_URL] : []),
		...desktopDevOrigins,
		"superset://app",
		"superset://",
		...(process.env.NODE_ENV === "development"
			? ["exp://", "exp://**", "exp://192.168.*.*:*/**"]
			: []),
	],
	session: {
		expiresIn: 60 * 60 * 24 * 30,
		updateAge: 60 * 60 * 24,
		storeSessionInDatabase: true,
		cookieCache: {
			enabled: true,
			maxAge: 60 * 5,
		},
	},
	advanced: {
		crossSubDomainCookies: {
			enabled: true,
			domain: env.NEXT_PUBLIC_COOKIE_DOMAIN,
		},
		database: {
			generateId: false,
		},
	},
	emailAndPassword: {
		enabled: true,
	},
	...(env.GH_CLIENT_ID && env.GH_CLIENT_SECRET
		? {
				socialProviders: {
					github: {
						clientId: env.GH_CLIENT_ID,
						clientSecret: env.GH_CLIENT_SECRET,
					},
				},
			}
		: {}),
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					const domain = user.email.split("@")[1]?.toLowerCase();
					let enrolledOrgId: string | null = null;

					if (domain) {
						const matchingOrgs = await db.query.organizations.findMany({
							where: sql`EXISTS (SELECT 1 FROM json_each(${authSchema.organizations.allowedDomains}) WHERE value = ${domain})`,
						});

						for (const org of matchingOrgs) {
							try {
								await auth.api.addMember({
									body: {
										organizationId: org.id,
										userId: user.id,
										role: "member",
									},
								});
								if (!enrolledOrgId) {
									enrolledOrgId = org.id;
								}
							} catch (error) {
								console.error(
									`[auto-enroll] Failed to add user ${user.id} to org ${org.id}:`,
									error,
								);
								const memberExists = await db.query.members.findFirst({
									where: and(
										eq(authSchema.members.organizationId, org.id),
										eq(authSchema.members.userId, user.id),
									),
								});
								if (memberExists && !enrolledOrgId) {
									enrolledOrgId = org.id;
								}
							}
						}
					}

					if (!enrolledOrgId) {
						const personalOrg = await auth.api.createOrganization({
							body: {
								name: `${user.name}'s Team`,
								slug: `${user.id.slice(0, 8)}-team`,
								userId: user.id,
							},
						});
						enrolledOrgId = personalOrg?.id ?? null;
					}

					if (enrolledOrgId) {
						await db
							.update(authSchema.sessions)
							.set({ activeOrganizationId: enrolledOrgId })
							.where(eq(authSchema.sessions.userId, user.id));
					}
				},
			},
		},
	},
	plugins: [
		apiKey({
			enableMetadata: true,
			enableSessionForAPIKeys: true,
			defaultPrefix: "sk_live_",
		}),
		jwt({
			jwks: {
				keyPairConfig: { alg: "RS256" },
			},
			jwt: {
				issuer: env.NEXT_PUBLIC_API_URL,
				audience: env.NEXT_PUBLIC_API_URL,
				expirationTime: "1h",
				definePayload: async ({
					user,
				}: {
					user: { id: string; email: string };
					session: Record<string, unknown>;
				}) => {
					const userMemberships = await db.query.members.findMany({
						where: eq(members.userId, user.id),
						columns: { organizationId: true },
					});
					const organizationIds = [
						...new Set(userMemberships.map((m) => m.organizationId)),
					];
					return { sub: user.id, email: user.email, organizationIds };
				},
			},
		}),
		oauthProvider({
			loginPage: `${env.NEXT_PUBLIC_WEB_URL}/sign-in`,
			consentPage: `${env.NEXT_PUBLIC_WEB_URL}/oauth/consent`,
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
			validAudiences: [env.NEXT_PUBLIC_API_URL, `${env.NEXT_PUBLIC_API_URL}/`],
			silenceWarnings: {
				oauthAuthServerConfig: true,
				openidConfig: true,
			},
			postLogin: {
				page: `${env.NEXT_PUBLIC_WEB_URL}/oauth/consent`,
				shouldRedirect: () => false,
				consentReferenceId: ({ session }) => {
					const activeOrganizationId = (
						session as { activeOrganizationId?: string }
					).activeOrganizationId;
					if (!activeOrganizationId) {
						throw new Error("Organization must be selected before consent");
					}
					return activeOrganizationId;
				},
			},
			customAccessTokenClaims: ({ referenceId }) => ({
				organizationId: referenceId ?? undefined,
			}),
		}),
		expo(),
		organization({
			creatorRole: "owner",
			invitationExpiresIn: 60 * 60 * 24 * 7,
			sendInvitationEmail: async (data) => {
				const token = await generateMagicTokenForInvite({
					email: data.email,
				});

				const inviteLink = `${env.NEXT_PUBLIC_WEB_URL}/accept-invitation/${data.id}?token=${token}`;

				// Log invitation link for local dev (no email service needed)
				console.log(
					`[invitation] Invite for ${data.email} to ${data.organization.name}: ${inviteLink}`,
				);
			},
			organizationHooks: {
				beforeCreateInvitation: async (data) => {
					const { inviterId, organizationId, role } = data.invitation;

					const rateLimitResult = await invitationRateLimit(inviterId);
					if (!rateLimitResult.success) {
						throw new Error(
							"Rate limit exceeded. Max 10 invitations per hour.",
						);
					}

					const inviterMember = await db.query.members.findFirst({
						where: and(
							eq(members.userId, inviterId),
							eq(members.organizationId, organizationId),
						),
					});

					if (!inviterMember) {
						throw new Error("Not a member of this organization");
					}

					if (
						!canInvite(
							inviterMember.role as OrganizationRole,
							role as OrganizationRole,
						)
					) {
						throw new Error("Cannot invite users with this role");
					}
				},

				afterCreateOrganization: async ({ organization }) => {
					console.log(
						`[org] Created organization: ${organization.name} (${organization.id})`,
					);
				},

				beforeAddMember: async () => {
					// Paywall removed — all plans allow unlimited members
				},

				afterAddMember: async ({ member, user, organization }) => {
					console.log(
						`[org] ${user.name} (${member.role}) added to ${organization.name}`,
					);
				},

				afterRemoveMember: async ({ user, organization }) => {
					console.log(`[org] ${user.name} removed from ${organization.name}`);
				},
			},
		}),
		bearer(),
		customSession(async ({ user, session: baseSession }) => {
			const session = baseSession as typeof sessions.$inferSelect;

			let activeOrganizationId = session.activeOrganizationId;

			const allMemberships = await db.query.members.findMany({
				where: eq(members.userId, session.userId ?? user.id),
				orderBy: desc(members.createdAt),
			});

			const organizationIds = [
				...new Set(allMemberships.map((m) => m.organizationId)),
			];

			const membership = activeOrganizationId
				? allMemberships.find((m) => m.organizationId === activeOrganizationId)
				: allMemberships[0];

			if (!activeOrganizationId && membership?.organizationId) {
				activeOrganizationId = membership.organizationId;
				await db
					.update(authSchema.sessions)
					.set({ activeOrganizationId })
					.where(eq(authSchema.sessions.id, session.id));
			}

			// Paywall removed — treat all users as pro
			const plan = "pro";

			return {
				user,
				session: {
					...session,
					activeOrganizationId,
					organizationIds,
					role: membership?.role,
					plan,
				},
			};
		}),
		acceptInvitationEndpoint,
	],
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
