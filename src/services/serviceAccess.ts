import { ProfileType } from '@prisma/client';
import prisma from '../prisma/client';

type RoleAssignment = {
  roleId: number;
  roleName: string | null;
  distance: number;
  source: 'primary_role' | 'department_role';
  sourceDepartmentId: number | null;
};

type DepartmentAssignment = {
  departmentId: number;
  source: 'primary_department' | 'active_department' | 'department_role';
};

type UserAccessContext = {
  userId: number;
  roleName: string | null;
  currentProfileType: ProfileType | null;
  activeDepartmentId: number | null;
  roleIds: Set<number>;
  roleAssignments: RoleAssignment[];
  roleDistanceById: Map<number, number>;
  departmentIds: Set<number>;
  departmentAssignments: DepartmentAssignment[];
  availableDepartmentIds: Set<number>;
  isEmployee: boolean;
  isAdmin: boolean;
};

type RuleField = 'visible' | 'enabled';

type RuleMatchBase = {
  id: number;
  visible: boolean | null;
  enabled: boolean | null;
};

type UserRuleMatch = RuleMatchBase & {
  userId: number;
  userName: string | null;
};

type RoleRuleMatch = RuleMatchBase & {
  roleId: number;
  roleName: string | null;
  roleDisplayName: string | null;
  distance: number;
};

type DepartmentRuleMatch = RuleMatchBase & {
  departmentId: number;
  departmentName: string | null;
};

type DepartmentRoleRuleMatch = RuleMatchBase & {
  departmentId: number;
  departmentName: string | null;
  roleId: number;
  roleName: string | null;
  roleDisplayName: string | null;
  distance: number;
};

type LayerDecision<T> = {
  value: boolean;
  origin: 'default' | 'explicit';
  matchedRules: T[];
};

type ResolvedFieldDecision = {
  value: boolean;
  source: 'default' | 'role' | 'department' | 'department_role' | 'user';
};

type ServiceAccessDecision = {
  visible: boolean;
  enabled: boolean;
  finalVisible: ResolvedFieldDecision;
  finalEnabled: ResolvedFieldDecision;
  userVisible: LayerDecision<UserRuleMatch>;
  userEnabled: LayerDecision<UserRuleMatch>;
  departmentRoleVisible: LayerDecision<DepartmentRoleRuleMatch>;
  departmentRoleEnabled: LayerDecision<DepartmentRoleRuleMatch>;
  roleVisible: LayerDecision<RoleRuleMatch>;
  roleEnabled: LayerDecision<RoleRuleMatch>;
  departmentVisible: LayerDecision<DepartmentRuleMatch>;
  departmentEnabled: LayerDecision<DepartmentRuleMatch>;
};

export type ServiceAccessView = {
  id: number;
  key: string;
  name: string;
  kind: 'LOCAL' | 'CLOUD';
  route: string | null;
  icon: string | null;
  description: string | null;
  gradientStart: string | null;
  gradientEnd: string | null;
  visible: boolean;
  enabled: boolean;
};

export type ServiceAdminView = {
  id: number;
  key: string;
  name: string;
  kind: 'LOCAL' | 'CLOUD';
  route: string | null;
  icon: string | null;
  description: string | null;
  gradientStart: string | null;
  gradientEnd: string | null;
  isActive: boolean;
  defaultVisible: boolean;
  defaultEnabled: boolean;
  roleAccess: Array<{
    id: number;
    roleId: number;
    visible: boolean | null;
    enabled: boolean | null;
  }>;
  departmentAccess: Array<{
    id: number;
    departmentId: number;
    visible: boolean | null;
    enabled: boolean | null;
  }>;
  departmentRoleAccess: Array<{
    id: number;
    departmentId: number;
    roleId: number;
    visible: boolean | null;
    enabled: boolean | null;
  }>;
  userAccess: Array<{
    id: number;
    userId: number;
    visible: boolean | null;
    enabled: boolean | null;
  }>;
};

export type ServiceAccessExplanation = {
  service: {
    id: number;
    key: string;
    name: string;
    isActive: boolean;
    defaultVisible: boolean;
    defaultEnabled: boolean;
  };
  context: {
    userId: number;
    roleName: string | null;
    currentProfileType: ProfileType | null;
    activeDepartmentId: number | null;
    roleAssignments: RoleAssignment[];
    departmentAssignments: DepartmentAssignment[];
    isEmployee: boolean;
    isAdmin: boolean;
  };
  access: {
    visible: boolean;
    enabled: boolean;
    isEmployee: boolean;
    isAdmin: boolean;
    reasonCodes: string[];
  };
  evaluation: {
    baseVisible: boolean;
    baseEnabled: boolean;
    finalVisible: ResolvedFieldDecision;
    finalEnabled: ResolvedFieldDecision;
    userVisible: LayerDecision<UserRuleMatch>;
    userEnabled: LayerDecision<UserRuleMatch>;
    departmentRoleVisible: LayerDecision<DepartmentRoleRuleMatch>;
    departmentRoleEnabled: LayerDecision<DepartmentRoleRuleMatch>;
    roleVisible: LayerDecision<RoleRuleMatch>;
    roleEnabled: LayerDecision<RoleRuleMatch>;
    departmentVisible: LayerDecision<DepartmentRuleMatch>;
    departmentEnabled: LayerDecision<DepartmentRuleMatch>;
  };
};

export type ServiceAccessMatrixItem = {
  user: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    currentProfileType: ProfileType | null;
    role: { id: number; name: string; displayName: string | null } | null;
    department: { id: number; name: string } | null;
    activeDepartment: { id: number; name: string } | null;
  };
  access: ServiceAccessExplanation['access'];
  evaluation: ServiceAccessExplanation['evaluation'];
};

const ADMIN_ROLE_NAMES = new Set(['admin', 'administrator']);

async function getRoleHierarchyByName(roleName: string): Promise<Set<string>> {
  const names = new Set<string>();
  let current: string | null = roleName;

  while (current) {
    if (names.has(current)) break;
    names.add(current);
    const res: { parentRole: { name: string } | null } | null = await prisma.role.findUnique({
      where: { name: current },
      select: { parentRole: { select: { name: true } } },
    });
    current = res?.parentRole?.name ?? null;
  }

  return names;
}

async function collectRoleChain(roleId?: number | null): Promise<Array<{ roleId: number; distance: number }>> {
  const chain: Array<{ roleId: number; distance: number }> = [];
  const visited = new Set<number>();
  let current = roleId ?? null;
  let distance = 0;

  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    chain.push({ roleId: current, distance });
    const next = await prisma.role.findUnique({
      where: { id: current },
      select: { parentRoleId: true },
    });
    current = next?.parentRoleId ?? null;
    distance += 1;
  }

  return chain;
}

async function resolveUserAccessContext(userId: number): Promise<UserAccessContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roleId: true,
      role: { select: { name: true } },
      currentProfileType: true,
      employeeProfile: { select: { departmentId: true, activeDepartmentId: true } },
      departmentRoles: { select: { roleId: true, departmentId: true } },
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const roleName = user.role?.name ?? null;
  const roleChain = roleName ? await getRoleHierarchyByName(roleName) : new Set<string>();
  const isAdmin = roleName
    ? ADMIN_ROLE_NAMES.has(roleName) || roleChain.has('admin') || roleChain.has('administrator')
    : false;

  const primaryDepartmentId = user.employeeProfile?.departmentId ?? null;
  const activeDepartmentId = user.employeeProfile?.activeDepartmentId ?? primaryDepartmentId ?? null;

  const availableDepartmentIds = new Set<number>();
  if (primaryDepartmentId) availableDepartmentIds.add(primaryDepartmentId);
  if (activeDepartmentId) availableDepartmentIds.add(activeDepartmentId);
  for (const departmentRole of user.departmentRoles || []) {
    if (departmentRole.departmentId) availableDepartmentIds.add(departmentRole.departmentId);
  }

  const departmentAssignments: DepartmentAssignment[] = [];
  const effectiveDepartmentIds = new Set<number>();
  const addDepartmentAssignment = (
    departmentId: number | null | undefined,
    source: DepartmentAssignment['source']
  ) => {
    if (!departmentId) return;
    effectiveDepartmentIds.add(departmentId);
    if (!departmentAssignments.some((assignment) => assignment.departmentId === departmentId && assignment.source === source)) {
      departmentAssignments.push({ departmentId, source });
    }
  };

  if (activeDepartmentId) {
    addDepartmentAssignment(
      activeDepartmentId,
      activeDepartmentId === primaryDepartmentId ? 'primary_department' : 'active_department'
    );
    for (const departmentRole of user.departmentRoles || []) {
      if (departmentRole.departmentId === activeDepartmentId) {
        addDepartmentAssignment(departmentRole.departmentId, 'department_role');
      }
    }
  } else {
    addDepartmentAssignment(primaryDepartmentId, 'primary_department');
    for (const departmentRole of user.departmentRoles || []) {
      addDepartmentAssignment(departmentRole.departmentId, 'department_role');
    }
  }

  const relevantDepartmentRoles = activeDepartmentId
    ? (user.departmentRoles || []).filter((departmentRole) => departmentRole.departmentId === activeDepartmentId)
    : user.departmentRoles || [];

  const roleAssignments: RoleAssignment[] = [];
  if (user.roleId) {
    const chain = await collectRoleChain(user.roleId);
    chain.forEach((entry) =>
      roleAssignments.push({
        roleId: entry.roleId,
        roleName,
        distance: entry.distance,
        source: 'primary_role',
        sourceDepartmentId: null,
      })
    );
  }

  for (const departmentRole of relevantDepartmentRoles) {
    const chain = await collectRoleChain(departmentRole.roleId);
    chain.forEach((entry) =>
      roleAssignments.push({
        roleId: entry.roleId,
        roleName: null,
        distance: entry.distance,
        source: 'department_role',
        sourceDepartmentId: departmentRole.departmentId,
      })
    );
  }

  const roleIds = new Set<number>();
  const roleDistanceById = new Map<number, number>();
  for (const assignment of roleAssignments) {
    roleIds.add(assignment.roleId);
    const prev = roleDistanceById.get(assignment.roleId);
    if (prev === undefined || assignment.distance < prev) {
      roleDistanceById.set(assignment.roleId, assignment.distance);
    }
  }

  return {
    userId,
    roleName,
    currentProfileType: user.currentProfileType,
    activeDepartmentId,
    roleIds,
    roleAssignments,
    roleDistanceById,
    departmentIds: effectiveDepartmentIds,
    departmentAssignments,
    availableDepartmentIds,
    isEmployee: user.currentProfileType === 'EMPLOYEE',
    isAdmin,
  };
}

function evaluateUserField(
  base: boolean,
  rules: UserRuleMatch[],
  field: RuleField
): LayerDecision<UserRuleMatch> {
  const explicitRules = rules.filter((rule) => typeof rule[field] === 'boolean');
  if (!explicitRules.length) return { value: base, origin: 'default', matchedRules: [] };
  if (explicitRules.some((rule) => rule[field] === false)) {
    return {
      value: false,
      origin: 'explicit',
      matchedRules: explicitRules.filter((rule) => rule[field] === false),
    };
  }
  return {
    value: true,
    origin: 'explicit',
    matchedRules: explicitRules.filter((rule) => rule[field] === true),
  };
}

function evaluateDepartmentField(
  base: boolean,
  rules: DepartmentRuleMatch[],
  field: RuleField
): LayerDecision<DepartmentRuleMatch> {
  const explicitRules = rules.filter((rule) => typeof rule[field] === 'boolean');
  if (!explicitRules.length) return { value: base, origin: 'default', matchedRules: [] };
  if (explicitRules.some((rule) => rule[field] === false)) {
    return {
      value: false,
      origin: 'explicit',
      matchedRules: explicitRules.filter((rule) => rule[field] === false),
    };
  }
  return {
    value: true,
    origin: 'explicit',
    matchedRules: explicitRules.filter((rule) => rule[field] === true),
  };
}

function evaluateRoleField(
  base: boolean,
  rules: RoleRuleMatch[],
  field: RuleField
): LayerDecision<RoleRuleMatch> {
  const explicitRules = rules.filter((rule) => typeof rule[field] === 'boolean');
  if (!explicitRules.length) return { value: base, origin: 'default', matchedRules: [] };

  const minDistance = explicitRules.reduce(
    (value, rule) => Math.min(value, rule.distance),
    Number.MAX_SAFE_INTEGER
  );
  const nearestRules = explicitRules.filter((rule) => rule.distance === minDistance);
  if (nearestRules.some((rule) => rule[field] === false)) {
    return {
      value: false,
      origin: 'explicit',
      matchedRules: nearestRules.filter((rule) => rule[field] === false),
    };
  }
  return {
    value: true,
    origin: 'explicit',
    matchedRules: nearestRules.filter((rule) => rule[field] === true),
  };
}

function evaluateDepartmentRoleField(
  base: boolean,
  rules: DepartmentRoleRuleMatch[],
  field: RuleField
): LayerDecision<DepartmentRoleRuleMatch> {
  const explicitRules = rules.filter((rule) => typeof rule[field] === 'boolean');
  if (!explicitRules.length) return { value: base, origin: 'default', matchedRules: [] };

  const minDistance = explicitRules.reduce(
    (value, rule) => Math.min(value, rule.distance),
    Number.MAX_SAFE_INTEGER
  );
  const nearestRules = explicitRules.filter((rule) => rule.distance === minDistance);
  if (nearestRules.some((rule) => rule[field] === false)) {
    return {
      value: false,
      origin: 'explicit',
      matchedRules: nearestRules.filter((rule) => rule[field] === false),
    };
  }
  return {
    value: true,
    origin: 'explicit',
    matchedRules: nearestRules.filter((rule) => rule[field] === true),
  };
}

function resolveFinalField(
  base: boolean,
  userDecision: LayerDecision<UserRuleMatch>,
  departmentRoleDecision: LayerDecision<DepartmentRoleRuleMatch>,
  departmentDecision: LayerDecision<DepartmentRuleMatch>,
  roleDecision: LayerDecision<RoleRuleMatch>
): ResolvedFieldDecision {
  if (userDecision.origin === 'explicit') return { value: userDecision.value, source: 'user' };
  if (departmentRoleDecision.origin === 'explicit') {
    return { value: departmentRoleDecision.value, source: 'department_role' };
  }
  if (departmentDecision.origin === 'explicit') return { value: departmentDecision.value, source: 'department' };
  if (roleDecision.origin === 'explicit') return { value: roleDecision.value, source: 'role' };
  return { value: base, source: 'default' };
}

function applyRuleFlags(
  baseVisible: boolean,
  baseEnabled: boolean,
  userRules: UserRuleMatch[],
  departmentRoleRules: DepartmentRoleRuleMatch[],
  roleRules: RoleRuleMatch[],
  departmentRules: DepartmentRuleMatch[]
): ServiceAccessDecision {
  const userVisible = evaluateUserField(baseVisible, userRules, 'visible');
  const userEnabled = evaluateUserField(baseEnabled, userRules, 'enabled');
  const departmentRoleVisible = evaluateDepartmentRoleField(baseVisible, departmentRoleRules, 'visible');
  const departmentRoleEnabled = evaluateDepartmentRoleField(baseEnabled, departmentRoleRules, 'enabled');
  const roleVisible = evaluateRoleField(baseVisible, roleRules, 'visible');
  const roleEnabled = evaluateRoleField(baseEnabled, roleRules, 'enabled');
  const departmentVisible = evaluateDepartmentField(baseVisible, departmentRules, 'visible');
  const departmentEnabled = evaluateDepartmentField(baseEnabled, departmentRules, 'enabled');

  const finalVisible = resolveFinalField(
    baseVisible,
    userVisible,
    departmentRoleVisible,
    departmentVisible,
    roleVisible
  );
  const rawEnabled = resolveFinalField(
    baseEnabled,
    userEnabled,
    departmentRoleEnabled,
    departmentEnabled,
    roleEnabled
  );
  const visible = finalVisible.value;
  const enabled = visible ? rawEnabled.value : false;
  const finalEnabled = visible ? rawEnabled : { value: false, source: rawEnabled.source };

  return {
    visible,
    enabled,
    finalVisible,
    finalEnabled,
    userVisible,
    userEnabled,
    departmentRoleVisible,
    departmentRoleEnabled,
    roleVisible,
    roleEnabled,
    departmentVisible,
    departmentEnabled,
  };
}

function toServiceAccessView(service: {
  id: number;
  key: string;
  name: string;
  kind: 'LOCAL' | 'CLOUD';
  route: string | null;
  icon: string | null;
  description: string | null;
  gradientStart: string | null;
  gradientEnd: string | null;
}) {
  return {
    id: service.id,
    key: service.key,
    name: service.name,
    kind: service.kind,
    route: service.route,
    icon: service.icon,
    description: service.description,
    gradientStart: service.gradientStart,
    gradientEnd: service.gradientEnd,
  };
}

function mapMatchedDepartmentRoleRules(
  ctx: UserAccessContext,
  rules: Array<{
    id: number;
    departmentId: number;
    roleId: number;
    visible: boolean | null;
    enabled: boolean | null;
    department?: { id: number; name: string } | null;
    role?: { id: number; name: string; displayName: string | null } | null;
  }>
): DepartmentRoleRuleMatch[] {
  return rules
    .map((rule) => {
      const matchingAssignments = ctx.roleAssignments.filter((assignment) => {
        if (assignment.roleId !== rule.roleId) return false;

        if (assignment.source === 'primary_role') {
          return ctx.departmentIds.has(rule.departmentId);
        }

        return assignment.sourceDepartmentId === rule.departmentId;
      });
      if (!matchingAssignments.length) return null;
      const distance = matchingAssignments.reduce(
        (value, assignment) => Math.min(value, assignment.distance),
        Number.MAX_SAFE_INTEGER
      );
      return {
        id: rule.id,
        departmentId: rule.departmentId,
        departmentName: rule.department?.name ?? null,
        roleId: rule.roleId,
        roleName: rule.role?.name ?? null,
        roleDisplayName: rule.role?.displayName ?? null,
        visible: rule.visible,
        enabled: rule.enabled,
        distance,
      } satisfies DepartmentRoleRuleMatch;
    })
    .filter((rule): rule is DepartmentRoleRuleMatch => Boolean(rule));
}

function buildReasonCodes(input: {
  isEmployee: boolean;
  isAdmin: boolean;
  serviceIsActive: boolean;
  visible: boolean;
  enabled: boolean;
}) {
  if (input.isAdmin) return [];
  if (!input.isEmployee) return ['NOT_EMPLOYEE_PROFILE'];

  const codes: string[] = [];
  if (!input.serviceIsActive) codes.push('SERVICE_INACTIVE');
  if (!input.visible) codes.push('SERVICE_HIDDEN');
  if (input.visible && !input.enabled) codes.push('SERVICE_DISABLED');
  return codes;
}

export async function explainServiceAccessForUser(
  userId: number,
  lookup: { serviceId: number } | { serviceKey: string }
): Promise<ServiceAccessExplanation | null> {
  const ctx = await resolveUserAccessContext(userId);
  const service = await prisma.service.findUnique({
    where: 'serviceId' in lookup ? { id: lookup.serviceId } : { key: lookup.serviceKey },
    include: {
      userAccess: {
        where: { userId },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
      departmentRoleAccess: {
        where: {
          departmentId: { in: Array.from(ctx.departmentIds) },
          roleId: { in: Array.from(ctx.roleIds) },
        },
        include: {
          department: { select: { id: true, name: true } },
          role: { select: { id: true, name: true, displayName: true } },
        },
      },
      roleAccess: {
        where: { roleId: { in: Array.from(ctx.roleIds) } },
        include: {
          role: { select: { id: true, name: true, displayName: true } },
        },
      },
      departmentAccess: {
        where: { departmentId: { in: Array.from(ctx.departmentIds) } },
        include: {
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!service) return null;

  const baseVisible = service.isActive && service.defaultVisible;
  const baseEnabled = service.isActive && service.defaultEnabled;

  if (ctx.isAdmin) {
    return {
      service: {
        id: service.id,
        key: service.key,
        name: service.name,
        isActive: service.isActive,
        defaultVisible: service.defaultVisible,
        defaultEnabled: service.defaultEnabled,
      },
      context: {
        userId,
        roleName: ctx.roleName,
        currentProfileType: ctx.currentProfileType,
        activeDepartmentId: ctx.activeDepartmentId,
        roleAssignments: ctx.roleAssignments,
        departmentAssignments: ctx.departmentAssignments,
        isEmployee: true,
        isAdmin: true,
      },
      access: {
        visible: true,
        enabled: true,
        isEmployee: true,
        isAdmin: true,
        reasonCodes: [],
      },
      evaluation: {
        baseVisible,
        baseEnabled,
        finalVisible: { value: true, source: 'default' },
        finalEnabled: { value: true, source: 'default' },
        userVisible: { value: true, origin: 'default', matchedRules: [] },
        userEnabled: { value: true, origin: 'default', matchedRules: [] },
        departmentRoleVisible: { value: true, origin: 'default', matchedRules: [] },
        departmentRoleEnabled: { value: true, origin: 'default', matchedRules: [] },
        roleVisible: { value: true, origin: 'default', matchedRules: [] },
        roleEnabled: { value: true, origin: 'default', matchedRules: [] },
        departmentVisible: { value: true, origin: 'default', matchedRules: [] },
        departmentEnabled: { value: true, origin: 'default', matchedRules: [] },
      },
    };
  }

  const userRules: UserRuleMatch[] = (service.userAccess ?? []).map((rule) => ({
    id: rule.id,
    userId: rule.userId,
    userName:
      [rule.user.firstName, rule.user.lastName].filter(Boolean).join(' ').trim() ||
      rule.user.email ||
      null,
    visible: rule.visible,
    enabled: rule.enabled,
  }));

  const roleRules: RoleRuleMatch[] = (service.roleAccess ?? []).map((rule) => ({
    id: rule.id,
    roleId: rule.roleId,
    roleName: rule.role.name,
    roleDisplayName: rule.role.displayName ?? null,
    visible: rule.visible,
    enabled: rule.enabled,
    distance: ctx.roleDistanceById.get(rule.roleId) ?? Number.MAX_SAFE_INTEGER,
  }));

  const departmentRules: DepartmentRuleMatch[] = (service.departmentAccess ?? []).map((rule) => ({
    id: rule.id,
    departmentId: rule.departmentId,
    departmentName: rule.department.name,
    visible: rule.visible,
    enabled: rule.enabled,
  }));
  const departmentRoleRules = mapMatchedDepartmentRoleRules(ctx, service.departmentRoleAccess ?? []);

  const decision = applyRuleFlags(
    baseVisible,
    baseEnabled,
    userRules,
    departmentRoleRules,
    roleRules,
    departmentRules
  );
  const reasonCodes = buildReasonCodes({
    isEmployee: ctx.isEmployee,
    isAdmin: false,
    serviceIsActive: service.isActive,
    visible: ctx.isEmployee ? decision.visible : false,
    enabled: ctx.isEmployee ? decision.enabled : false,
  });

  return {
    service: {
      id: service.id,
      key: service.key,
      name: service.name,
      isActive: service.isActive,
      defaultVisible: service.defaultVisible,
      defaultEnabled: service.defaultEnabled,
    },
    context: {
      userId,
      roleName: ctx.roleName,
      currentProfileType: ctx.currentProfileType,
      activeDepartmentId: ctx.activeDepartmentId,
      roleAssignments: ctx.roleAssignments,
      departmentAssignments: ctx.departmentAssignments,
      isEmployee: ctx.isEmployee,
      isAdmin: false,
    },
    access: {
      visible: ctx.isEmployee ? decision.visible : false,
      enabled: ctx.isEmployee ? decision.enabled : false,
      isEmployee: ctx.isEmployee,
      isAdmin: false,
      reasonCodes,
    },
    evaluation: {
      baseVisible,
      baseEnabled,
      finalVisible: decision.finalVisible,
      finalEnabled: decision.finalEnabled,
      userVisible: decision.userVisible,
      userEnabled: decision.userEnabled,
      departmentRoleVisible: decision.departmentRoleVisible,
      departmentRoleEnabled: decision.departmentRoleEnabled,
      roleVisible: decision.roleVisible,
      roleEnabled: decision.roleEnabled,
      departmentVisible: decision.departmentVisible,
      departmentEnabled: decision.departmentEnabled,
    },
  };
}

export async function resolveServiceAccessForUser(userId: number, serviceKey: string) {
  const explanation = await explainServiceAccessForUser(userId, { serviceKey });
  if (!explanation) return null;

  const service = await prisma.service.findUnique({ where: { key: serviceKey } });
  if (!service) return null;

  if (explanation.access.isAdmin) {
    return { service, visible: true, enabled: true, isEmployee: true };
  }

  if (!explanation.access.isEmployee) {
    return { service, visible: false, enabled: false, isEmployee: false };
  }

  return {
    service,
    visible: explanation.access.visible,
    enabled: explanation.access.enabled,
    isEmployee: true,
  };
}

export async function listServicesForUser(
  userId: number
): Promise<{ services: ServiceAccessView[]; isEmployee: boolean }> {
  const ctx = await resolveUserAccessContext(userId);
  const services = await prisma.service.findMany({
    where: { isActive: true },
    orderBy: { id: 'asc' },
    include: {
      userAccess: { where: { userId }, select: { id: true, userId: true, visible: true, enabled: true } },
      departmentRoleAccess: {
        where: {
          departmentId: { in: Array.from(ctx.departmentIds) },
          roleId: { in: Array.from(ctx.roleIds) },
        },
        select: {
          id: true,
          departmentId: true,
          roleId: true,
          visible: true,
          enabled: true,
        },
      },
      roleAccess: {
        where: { roleId: { in: Array.from(ctx.roleIds) } },
        select: { id: true, roleId: true, serviceId: true, visible: true, enabled: true },
      },
      departmentAccess: {
        where: { departmentId: { in: Array.from(ctx.departmentIds) } },
        select: { id: true, departmentId: true, serviceId: true, visible: true, enabled: true },
      },
    },
  });

  if (ctx.isAdmin) {
    return {
      services: services.map((service) => ({
        ...toServiceAccessView(service),
        visible: true,
        enabled: true,
      })),
      isEmployee: true,
    };
  }

  if (!ctx.isEmployee) {
    return { services: [], isEmployee: false };
  }

  return {
    services: services.map((service) => {
      const baseVisible = service.isActive && service.defaultVisible;
      const baseEnabled = service.isActive && service.defaultEnabled;
      const decision = applyRuleFlags(
        baseVisible,
        baseEnabled,
        (service.userAccess ?? []).map((rule) => ({
          id: rule.id,
          userId: rule.userId,
          userName: null,
          visible: rule.visible,
          enabled: rule.enabled,
        })),
        mapMatchedDepartmentRoleRules(ctx, service.departmentRoleAccess ?? []),
        (service.roleAccess ?? []).map((rule) => ({
          id: rule.id,
          roleId: rule.roleId,
          roleName: null,
          roleDisplayName: null,
          visible: rule.visible,
          enabled: rule.enabled,
          distance: ctx.roleDistanceById.get(rule.roleId) ?? Number.MAX_SAFE_INTEGER,
        })),
        (service.departmentAccess ?? []).map((rule) => ({
          id: rule.id,
          departmentId: rule.departmentId,
          departmentName: null,
          visible: rule.visible,
          enabled: rule.enabled,
        }))
      );
      return {
        ...toServiceAccessView(service),
        visible: decision.visible,
        enabled: decision.enabled,
      };
    }),
    isEmployee: true,
  };
}

export async function listServicesForAdmin(): Promise<ServiceAdminView[]> {
  const services = await prisma.service.findMany({
    orderBy: { id: 'asc' },
    include: {
      roleAccess: { select: { id: true, roleId: true, visible: true, enabled: true } },
      departmentAccess: { select: { id: true, departmentId: true, visible: true, enabled: true } },
      departmentRoleAccess: {
        select: { id: true, departmentId: true, roleId: true, visible: true, enabled: true },
      },
      userAccess: { select: { id: true, userId: true, visible: true, enabled: true } },
    },
  });

  return services.map((service) => ({
    id: service.id,
    key: service.key,
    name: service.name,
    kind: service.kind,
    route: service.route,
    icon: service.icon,
    description: service.description,
    gradientStart: service.gradientStart,
    gradientEnd: service.gradientEnd,
    isActive: service.isActive,
    defaultVisible: service.defaultVisible,
    defaultEnabled: service.defaultEnabled,
    roleAccess: service.roleAccess,
    departmentAccess: service.departmentAccess,
    departmentRoleAccess: service.departmentRoleAccess,
    userAccess: service.userAccess,
  }));
}

export async function listServiceAccessMatrix(input: {
  serviceId: number;
  page?: number;
  limit?: number;
  search?: string | null;
  roleId?: number | null;
  departmentId?: number | null;
}): Promise<{ items: ServiceAccessMatrixItem[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, Number(input.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 25));
  const skip = (page - 1) * limit;
  const search = String(input.search || '').trim();

  const service = await prisma.service.findUnique({
    where: { id: input.serviceId },
    select: { id: true },
  });
  if (!service) {
    throw new Error('Service not found');
  }

  const andWhere: any[] = [];
  if (input.roleId) {
    const roleId = Number(input.roleId);
    andWhere.push({
      OR: [
        { roleId },
        { departmentRoles: { some: { roleId } } },
      ],
    });
  }
  if (input.departmentId) {
    const departmentId = Number(input.departmentId);
    andWhere.push({
      OR: [
        { employeeProfile: { is: { departmentId } } },
        { employeeProfile: { is: { activeDepartmentId: departmentId } } },
        { departmentRoles: { some: { departmentId } } },
      ],
    });
  }
  if (search) {
    andWhere.push({
      OR: [
      { email: { contains: search, mode: 'insensitive' } },
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      ],
    });
  }
  const where = andWhere.length ? { AND: andWhere } : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ id: 'asc' }],
      skip,
      take: limit,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        currentProfileType: true,
        role: { select: { id: true, name: true, displayName: true } },
        employeeProfile: {
          select: {
            department: { select: { id: true, name: true } },
            activeDepartment: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const items = await Promise.all(
    users.map(async (user) => {
      const explanation = await explainServiceAccessForUser(user.id, { serviceId: input.serviceId });
      if (!explanation) {
        throw new Error('Service not found');
      }
      return {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          currentProfileType: user.currentProfileType,
          role: user.role
            ? {
                id: user.role.id,
                name: user.role.name,
                displayName: user.role.displayName ?? null,
              }
            : null,
          department: user.employeeProfile?.department ?? null,
          activeDepartment: user.employeeProfile?.activeDepartment ?? null,
        },
        access: explanation.access,
        evaluation: explanation.evaluation,
      } satisfies ServiceAccessMatrixItem;
    })
  );

  return { items, total, page, limit };
}
