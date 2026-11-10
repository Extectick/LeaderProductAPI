jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()}}}));
jest.mock('../src/services/presenceService',()=>({getPresenceForUsers:jest.fn(async()=>[])}));
jest.mock('../src/storage/minio',()=>({s3EnvPrefix:'dev',s3:{send:jest.fn()},resolveObjectUrl:jest.fn(async(value:string|null)=>value?'https://fixture.example/files/'+value+'?token=rotating':null)}));
import prisma from '../src/prisma/client';
import {getProfile} from '../src/services/userService';
import {profileAvatarAsset} from '../src/services/avatarService';
const user={id:7,firstName:'Test',lastName:'Person',email:null,middleName:null,phone:null,authProvider:'EMAIL',currentProfileType:'EMPLOYEE',profileStatus:'ACTIVE',isActive:true,role:{id:2,name:'employee',displayName:'Employee'},avatarUrl:'avatars/legacy.png',employeeProfile:{id:3,avatarUrl:null,status:'ACTIVE',departmentRoles:[],createdAt:new Date(),updatedAt:new Date()},clientProfile:null,supplierProfile:null};
beforeEach(()=>{jest.clearAllMocks();(prisma.user.findUnique as jest.Mock).mockResolvedValue(user);});
test('empty active profile falls back to legacy user avatar and keeps old URL contract',async()=>{
 const profile=await getProfile(7);
 expect(profile.avatarUrl).toBe('https://fixture.example/files/avatars/legacy.png?token=rotating');
 expect(profile).toMatchObject(profileAvatarAsset(7,'USER','avatars/legacy.png'));
 expect(profile.employeeProfile?.avatarAssetUrl).toBeNull();
});
test('active and nested metadata agree while another profile retains its distinct version',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,employeeProfile:{...user.employeeProfile,avatarUrl:'dev/images/avatars/new.jpg'},clientProfile:{id:4,avatarUrl:'avatars/client.jpg',createdAt:new Date(),updatedAt:new Date()}});
 const profile=await getProfile(7);
 expect(profile.avatarAssetUrl).toBe(profile.employeeProfile?.avatarAssetUrl);expect(profile.avatarVersion).toBe(profile.employeeProfile?.avatarVersion);
 expect(profile.clientProfile?.avatarVersion).not.toBe(profile.avatarVersion);
 expect(profile.avatarUrl).toContain('dev/images/avatars/new.jpg');
});
test('no photo is explicit null metadata, not a generated placeholder or signed token identity',async()=>{
 (prisma.user.findUnique as jest.Mock).mockResolvedValue({...user,avatarUrl:null});
 const profile=await getProfile(7);expect(profile).toMatchObject({avatarUrl:null,avatarAssetUrl:null,avatarVersion:null});
});
