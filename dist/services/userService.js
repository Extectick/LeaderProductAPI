"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userService = exports.updateProfile = exports.getProfile = void 0;
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const getProfile = async (userId) => {
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
    const transformProfile = (profile) => profile ? {
        ...profile,
        address: profile.addressId ? {
            street: '',
            city: '',
            country: '',
            state: null,
            postalCode: null
        } : null
    } : null;
    return {
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
};
exports.getProfile = getProfile;
const updateProfile = async (userId, data) => {
    return prisma.user.update({
        where: { id: userId },
        data: {
            firstName: data.firstName,
            lastName: data.lastName,
            middleName: data.middleName,
            phone: data.phone,
            avatarUrl: data.avatarUrl
        }
    });
};
exports.updateProfile = updateProfile;
exports.userService = {
    getProfile: exports.getProfile,
    updateProfile: exports.updateProfile
};
