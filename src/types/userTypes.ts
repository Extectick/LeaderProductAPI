import { AuthProvider, ProfileStatus, ProfileType } from "@prisma/client";

export type AuthMethods = {
    telegramLinked: boolean;
    passwordLoginEnabled: boolean;
    passwordLoginPendingVerification: boolean;
}

export type Profile = {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    middleName: string | null;
    phone: string | null;
    phoneVerifiedAt?: Date | string | null;
    telegramId?: string | null;
    telegramUsername?: string | null;
    authProvider?: AuthProvider;
    authMethods: AuthMethods;
    avatarUrl: string | null;
    lastSeenAt?: Date | string | null;
    isOnline?: boolean;
    profileStatus: ProfileStatus;
    currentProfileType: ProfileType | null;
    role: {
        id: number;
        name: string;
    };
    departmentRoles: Array<{
        department: {
        id: number;
        name: string;
        };
        role: {
        id: number;
        name: string;
        };
    }>;
    clientProfile?: clientProfile | null;
    supplierProfile?: supplierProfile | null;
    employeeProfile?: employeeProfile | null;
}

export type DepartmentRole = {
    department: {
    id: number;
    name: string;
    };
    role: {
    id: number;
    name: string;
    };
}

export type clientProfile = {
    id: number;
    avatarUrl?: string | null;
    lastSeenAt?: Date | string | null;
    isOnline?: boolean;
    status: ProfileStatus;
    address: {
    street: string;
    city: string;
    state: string | null;
    postalCode: string | null;
    country: string;
    } | null;
    counterparty?: {
    guid: string;
    name: string;
    isActive: boolean;
    } | null;
    activeAgreement?: {
    guid: string;
    name: string;
    currency: string | null;
    isActive: boolean;
    } | null;
    activeContract?: {
    guid: string;
    number: string;
    isActive: boolean;
    } | null;
    activeWarehouse?: {
    guid: string;
    name: string;
    isActive: boolean;
    isDefault: boolean;
    isPickup: boolean;
    } | null;
    activePriceType?: {
    guid: string;
    name: string;
    isActive: boolean;
    } | null;
    activeDeliveryAddress?: {
    guid: string | null;
    fullAddress: string;
    isActive: boolean;
    isDefault: boolean;
    } | null;
    createdAt: Date;
    updatedAt: Date;
}
export type supplierProfile = {
    id: number;
    avatarUrl?: string | null;
    lastSeenAt?: Date | string | null;
    isOnline?: boolean;
    status: ProfileStatus;
    address: {
    street: string;
    city: string;
    state: string | null;
    postalCode: string | null;
    country: string;
    } | null;
    createdAt: Date;
    updatedAt: Date;
}
export type employeeProfile = {
    id: number;
    avatarUrl?: string | null;
    lastSeenAt?: Date | string | null;
    isOnline?: boolean;
    status: ProfileStatus;
    department: {
    id: number;
    name: string;
    } | null;
    departmentRoles: Array<{
    id: number;
    role: {
        id: number;
        name: string;
    };
    }>;
    createdAt: Date;
    updatedAt: Date;
}
