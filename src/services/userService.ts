import prisma from '../prisma/client';
import { Profile } from '../types/userTypes';
import { getPresenceForUsers } from './presenceService';
import { resolveObjectUrl } from '../storage/minio';

export const userServicePrisma = prisma;

export const getProfile = async (userId: number): Promise<Profile> => {
  const user = await userServicePrisma.user.findUnique({
    where: { id: userId },
    include: {
      role: true,
      clientProfile: {
        include: {
          address: true,
          counterparty: { select: { guid: true, name: true, isActive: true } },
          activeAgreement: { select: { guid: true, name: true, currency: true, isActive: true } },
          activeContract: { select: { guid: true, number: true, isActive: true } },
          activeWarehouse: { select: { guid: true, name: true, isActive: true, isDefault: true, isPickup: true } },
          activePriceType: { select: { guid: true, name: true, isActive: true } },
          activeDeliveryAddress: { select: { guid: true, fullAddress: true, isActive: true, isDefault: true } },
        }
      },
      supplierProfile: {
        include: {
          address: true,
        }
      },
      employeeProfile: {
        include: {
          department: true,
          departmentRoles: {
            include: {
              role: true
            }
          }
        }
      }
    }
  });

  if (!user) {
    throw new Error('Пользователь не найден');
  }

  const presence = await getPresenceForUsers([userId]);
  const isOnline = presence[0]?.isOnline ?? false;
  const lastSeenAt = user.lastSeenAt ?? null;

  const resolvedClientAvatar = await resolveObjectUrl(user.clientProfile?.avatarUrl ?? null);
  const resolvedSupplierAvatar = await resolveObjectUrl(user.supplierProfile?.avatarUrl ?? null);
  const resolvedEmployeeAvatar = await resolveObjectUrl(user.employeeProfile?.avatarUrl ?? null);

  // Преобразуем departmentRoles к нужному формату
  const departmentRoles = (user.employeeProfile?.departmentRoles || []).map(dr => ({
    department: {
      id: dr.departmentId,
      name: user.employeeProfile?.department?.name || ''
    },
    role: dr.role
  }));

  // Преобразуем профили клиента/поставщика в предсказуемую форму
  const transformProfile = (profile: any, avatarUrl: string | null) =>
    profile
      ? {
          id: profile.id,
          phone: profile.phone ?? null,
          avatarUrl,
          lastSeenAt,
          isOnline,
          status: profile.status,
          address: profile.address
            ? {
                street: profile.address.street,
                city: profile.address.city,
                state: profile.address.state,
                postalCode: profile.address.postalCode,
                country: profile.address.country,
              }
            : null,
          counterparty: profile.counterparty
            ? {
                guid: profile.counterparty.guid,
                name: profile.counterparty.name,
                isActive: profile.counterparty.isActive,
              }
            : null,
          activeAgreement: profile.activeAgreement
            ? {
                guid: profile.activeAgreement.guid,
                name: profile.activeAgreement.name,
                currency: profile.activeAgreement.currency ?? null,
                isActive: profile.activeAgreement.isActive,
              }
            : null,
          activeContract: profile.activeContract
            ? {
                guid: profile.activeContract.guid,
                number: profile.activeContract.number,
                isActive: profile.activeContract.isActive,
              }
            : null,
          activeWarehouse: profile.activeWarehouse
            ? {
                guid: profile.activeWarehouse.guid,
                name: profile.activeWarehouse.name,
                isActive: profile.activeWarehouse.isActive,
                isDefault: profile.activeWarehouse.isDefault,
                isPickup: profile.activeWarehouse.isPickup,
              }
            : null,
          activePriceType: profile.activePriceType
            ? {
                guid: profile.activePriceType.guid,
                name: profile.activePriceType.name,
                isActive: profile.activePriceType.isActive,
              }
            : null,
          activeDeliveryAddress: profile.activeDeliveryAddress
            ? {
                guid: profile.activeDeliveryAddress.guid,
                fullAddress: profile.activeDeliveryAddress.fullAddress,
                isActive: profile.activeDeliveryAddress.isActive,
                isDefault: profile.activeDeliveryAddress.isDefault,
              }
            : null,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        }
      : null;

  const employeeProfile = user.employeeProfile
    ? {
        id: user.employeeProfile.id,
        phone: user.employeeProfile.phone ?? null,
        avatarUrl: resolvedEmployeeAvatar,
        lastSeenAt,
        isOnline,
        status: user.employeeProfile.status,
        department: user.employeeProfile.department
          ? { id: user.employeeProfile.department.id, name: user.employeeProfile.department.name }
          : null,
        departmentRoles: user.employeeProfile.departmentRoles?.map((dr: any) => ({
          id: dr.id,
          role: dr.role,
        })) ?? [],
        createdAt: user.employeeProfile.createdAt,
        updatedAt: user.employeeProfile.updatedAt,
      }
    : null;

  const activeAvatarUrl =
    user.currentProfileType === 'CLIENT'
      ? resolvedClientAvatar
      : user.currentProfileType === 'SUPPLIER'
      ? resolvedSupplierAvatar
      : user.currentProfileType === 'EMPLOYEE'
      ? resolvedEmployeeAvatar
      : null;

  const profile: Profile = {
      id: user.id,
      email: user.email ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      middleName: user.middleName,
      phone: user.phone,
      telegramId: user.telegramId ? user.telegramId.toString() : null,
      telegramUsername: user.telegramUsername ?? null,
      authProvider: user.authProvider,
      avatarUrl: activeAvatarUrl,
      lastSeenAt,
      isOnline,
      profileStatus: user.profileStatus,
      currentProfileType: user.currentProfileType,
      role: user.role,
      departmentRoles,
      clientProfile: transformProfile(user.clientProfile, resolvedClientAvatar),
      supplierProfile: transformProfile(user.supplierProfile, resolvedSupplierAvatar),
      employeeProfile: employeeProfile
  };

  return profile;
};

export const updateProfile = async (userId: number, data: Partial<Profile>) => {
  const updated = await userServicePrisma.user.update({
    where: { id: userId },
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      middleName: data.middleName,
      phone: data.phone
    }
  });
  return updated;
};

export const userService = {
  getProfile,
  updateProfile
};
