import { PrismaClient } from '@prisma/client';
import { Profile } from '../types/userTypes';
import { cacheGet, cacheSet, cacheDel } from '../utils/cache';

const prisma = new PrismaClient();

export const getProfile = async (userId: number): Promise<Profile> => {
  const cacheKey = `user:profile:${userId}`;
  const cached = await cacheGet<Profile>(cacheKey);
  if (cached) return cached;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      role: true,
      clientProfile: true,
      supplierProfile: true,
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

  // Преобразуем departmentRoles к нужному формату
  const departmentRoles = (user.employeeProfile?.departmentRoles || []).map(dr => ({
    department: {
      id: dr.departmentId,
      name: user.employeeProfile?.department?.name || ''
    },
    role: dr.role
  }));

  // Преобразуем профили клиента/поставщика
  const transformProfile = (profile: any) => profile ? {
    ...profile,
    address: profile.addressId ? {
      street: '',
      city: '',
      country: '',
      state: null,
      postalCode: null
    } : null
  } : null;

  const profile: Profile = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      middleName: user.middleName,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      profileStatus: user.profileStatus,
      currentProfileType: user.currentProfileType,
      role: user.role,
      departmentRoles,
      clientProfile: transformProfile(user.clientProfile),
      supplierProfile: transformProfile(user.supplierProfile),
      employeeProfile: user.employeeProfile
  };

  await cacheSet(cacheKey, profile, 300);
  return profile;
};

export const updateProfile = async (userId: number, data: Partial<Profile>) => {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      middleName: data.middleName,
      phone: data.phone,
      avatarUrl: data.avatarUrl
    }
  });
  await cacheDel(`user:profile:${userId}`);
  return updated;
};

export const userService = {
  getProfile,
  updateProfile
};
