import prisma from '../prisma/client';
import { Profile } from '../types/userTypes';

export const userServicePrisma = prisma;

export const getProfile = async (userId: number): Promise<Profile> => {
  const user = await userServicePrisma.user.findUnique({
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

  return profile;
};

export const updateProfile = async (userId: number, data: Partial<Profile>) => {
  const updated = await userServicePrisma.user.update({
    where: { id: userId },
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      middleName: data.middleName,
      phone: data.phone,
      avatarUrl: data.avatarUrl
    }
  });
  return updated;
};

export const userService = {
  getProfile,
  updateProfile
};
