import nodemailer from 'nodemailer';
import {mailProviders,type MailProvider} from './contract';
export function mailTransport(provider:MailProvider,email:string,password:string){return nodemailer.createTransport({host:mailProviders[provider].host,port:465,secure:true,auth:{user:email,pass:password},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false});}
