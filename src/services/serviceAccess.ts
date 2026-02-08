import prisma from '../prisma/client';

type UserAccessContext = {
  userId: number;
  roleName: string | null;
  roleIds: Set<number>;
  departmentIds: Set<number>;
  isEmployee: boolean;
  isAdmin: boolean;
};

export type ServiceAccessView = {
  id: number;
  key: string;
  name: string;
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
};

const ADMIN_ROLE_NAMES = new Set(['admin', 'administrator']);

async function getRoleHierarchyByName(roleName: string): Promise<Set<string>> {
  const names = new Set<string>();
  let current: string | null = roleName;

  while (current) {
    if (names.has(current)) break;
    names.add(current);
    const res: { parentRole: { name: string } | null } | null =
      await prisma.role.findUnique({
        where: { name: current },
        select: { parentRole: { select: { name: true } } },
      });
    current = res?.parentRole?.name ?? null;
  }

  return names;
}

async function collectRoleChain(roleId?: number | null): Promise<Set<number>> {
  const ids = new Set<number>();
  let current: number | null = roleId ?? null;

  while (current) {
    if (ids.has(current)) break;
    ids.add(current);
    const next = await prisma.role.findUnique({
      where: { id: current },
      select: { parentRoleId: true },
    });
    current = next?.parentRoleId ?? null;
  }

  return ids;
}

async function resolveUserAccessContext(userId: number): Promise<UserAccessContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      roleId: true,
      role: { select: { name: true } },
      currentProfileType: true,
      employeeProfile: { select: { departmentId: true } },
      departmentRoles: { select: { roleId: true, departmentId: true } },
    },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const roleName = user.role?.name ?? null;
  const roleChain = roleName ? await getRoleHierarchyByName(roleName) : new Set<string>();
  const isAdmin = roleName ? ADMIN_ROLE_NAMES.has(roleName) || roleChain.has('admin') || roleChain.has('administrator') : false;

  const seedRoleIds = new Set<number>();
  if (user.roleId) seedRoleIds.add(user.roleId);
  for (const dr of user.departmentRoles || []) {
    if (dr.roleId) seedRoleIds.add(dr.roleId);
  }

  const roleIds = new Set<number>();
  for (const rid of seedRoleIds) {
    const chain = await collectRoleChain(rid);
    chain.forEach((id) => roleIds.add(id));
  }

  const departmentIds = new Set<number>();
  if (user.employeeProfile?.departmentId) departmentIds.add(user.employeeProfile.departmentId);
  for (const dr of user.departmentRoles || []) {
    if (dr.departmentId) departmentIds.add(dr.departmentId);
  }

  const isEmployee = user.currentProfileType === 'EMPLOYEE';

  return {
    userId,
    roleName,
    roleIds,
    departmentIds,
    isEmployee,
    isAdmin,
  };
}

function applyRuleFlags(
  baseVisible: boolean,
  baseEnabled: boolean,
  roleRules: Array<{ visible: boolean | null; enabled: boolean | null }>,
  deptRules: Array<{ visible: boolean | null; enabled: boolean | null }>
) {
  const decide = (
    base: boolean,
    rules: Array<{ visible: boolean | null; enabled: boolean | null }>,
    field: 'visible' | 'enabled'
  ) => {
    const hasAny = rules.some((r) => typeof r[field] === 'boolean');
    if (!hasAny) return base;
    if (rules.some((r) => r[field] === false)) return false;
    if (rules.some((r) => r[field] === true)) return true;
    return base;
  };

  const roleVisible = decide(baseVisible, roleRules, 'visible');
  const deptVisible = decide(baseVisible, deptRules, 'visible');
  const roleEnabled = decide(baseEnabled, roleRules, 'enabled');
  const deptEnabled = decide(baseEnabled, deptRules, 'enabled');

  const visible = roleVisible && deptVisible;
  let enabled = roleEnabled && deptEnabled;

  if (!visible) enabled = false;

  return { visible, enabled };
}

export async function resolveServiceAccessForUser(userId: number, serviceKey: string) {
  const ctx = await resolveUserAccessContext(userId);
  const service = await prisma.service.findUnique({ where: { key: serviceKey } });

  if (!service) {
    return null;
  }

  if (!ctx.isEmployee) {
    return { service, visible: false, enabled: false, isEmployee: false };
  }

  if (ctx.isAdmin) {
    return { service, visible: true, enabled: true, isEmployee: true };
  }

  const baseVisible = service.isActive && service.defaultVisible;
  const baseEnabled = service.isActive && service.defaultEnabled;

  const roleIds = Array.from(ctx.roleIds);
  const deptIds = Array.from(ctx.departmentIds);

  const roleRules = roleIds.length
    ? await prisma.serviceRoleAccess.findMany({
        where: { serviceId: service.id, roleId: { in: roleIds } },
        select: { visible: true, enabled: true },
      })
    : [];
  const deptRules = deptIds.length
    ? await prisma.serviceDepartmentAccess.findMany({
        where: { serviceId: service.id, departmentId: { in: deptIds } },
        select: { visible: true, enabled: true },
      })
    : [];

  const decision = applyRuleFlags(baseVisible, baseEnabled, roleRules, deptRules);

  return { service, ...decision, isEmployee: true };
}

export async function listServicesForUser(
  userId: number
): Promise<{ services: ServiceAccessView[]; isEmployee: boolean }> {
  const ctx = await resolveUserAccessContext(userId);

  if (!ctx.isEmployee) {
    return { services: [], isEmployee: false };
  }

  const services = await prisma.service.findMany({
    where: { isActive: true },
    orderBy: { id: 'asc' },
  });

  if (ctx.isAdmin) {
    return {
      services: services.map((service) => ({
        id: service.id,
        key: service.key,
        name: service.name,
        route: service.route,
        icon: service.icon,
        description: service.description,
        gradientStart: service.gradientStart,
        gradientEnd: service.gradientEnd,
        visible: true,
        enabled: true,
      })),
      isEmployee: true,
    };
  }

  const roleIds = Array.from(ctx.roleIds);
  const deptIds = Array.from(ctx.departmentIds);
  const serviceIds = services.map((s) => s.id);

  const roleRules = roleIds.length
    ? await prisma.serviceRoleAccess.findMany({
        where: { serviceId: { in: serviceIds }, roleId: { in: roleIds } },
        select: { serviceId: true, visible: true, enabled: true },
      })
    : [];
  const deptRules = deptIds.length
    ? await prisma.serviceDepartmentAccess.findMany({
        where: { serviceId: { in: serviceIds }, departmentId: { in: deptIds } },
        select: { serviceId: true, visible: true, enabled: true },
      })
    : [];

  const roleMap = new Map<number, Array<{ visible: boolean | null; enabled: boolean | null }>>();
  const deptMap = new Map<number, Array<{ visible: boolean | null; enabled: boolean | null }>>();

  for (const rule of roleRules) {
    const list = roleMap.get(rule.serviceId) ?? [];
    list.push({ visible: rule.visible, enabled: rule.enabled });
    roleMap.set(rule.serviceId, list);
  }
  for (const rule of deptRules) {
    const list = deptMap.get(rule.serviceId) ?? [];
    list.push({ visible: rule.visible, enabled: rule.enabled });
    deptMap.set(rule.serviceId, list);
  }

  return {
    services: services.map((service) => {
      const baseVisible = service.isActive && service.defaultVisible;
      const baseEnabled = service.isActive && service.defaultEnabled;
      const roles = roleMap.get(service.id) ?? [];
      const depts = deptMap.get(service.id) ?? [];
      const decision = applyRuleFlags(baseVisible, baseEnabled, roles, depts);
      return {
        id: service.id,
        key: service.key,
        name: service.name,
        route: service.route,
        icon: service.icon,
        description: service.description,
        gradientStart: service.gradientStart,
        gradientEnd: service.gradientEnd,
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
    },
  });

  return services.map((service) => ({
    id: service.id,
    key: service.key,
    name: service.name,
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
  }));
}
