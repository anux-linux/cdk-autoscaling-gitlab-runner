import {
  CfnEIP,
  CloudFormationInit,
  IMachineImage,
  InitCommand,
  InitConfig,
  InitElement,
  InitFile,
  InitPackage,
  InitService,
  InitServiceRestartHandle,
  Instance,
  InstanceType,
  MultipartUserData,
  Peer,
  Port,
  Protocol,
  SecurityGroup,
  SubnetSelection,
  SubnetType,
  Vpc,
} from "@aws-cdk/aws-ec2";
import {
  CfnInstanceProfile,
  ManagedPolicy,
  PolicyDocument,
  Role,
  ServicePrincipal,
} from "@aws-cdk/aws-iam";
import { Bucket, BucketEncryption, LifecycleRule } from "@aws-cdk/aws-s3";
import {
  BucketDeployment,
  ServerSideEncryption,
  Source,
} from "@aws-cdk/aws-s3-deployment";
import { Construct, Stack, StackProps } from "@aws-cdk/core";
import { Domain } from "domain";

export interface GitlabRunnerStackProps extends StackProps {
  instanceTypeIdentifier: string;
  vpc: Vpc;
  machineImage: IMachineImage;
  /** These props come from "Parameters:" from runner.yml CFN template */
  cacheBucketName: string;
  cacheExpirationInDays: number;
  availabilityZone: any; // TODO: Provide some type
  vpcSubnet: SubnetSelection;
  managerImageId: any; // TODO: Provide some type
  managerInstanceType: any; // TODO: Provide some type
  managerKeyPair: any; // TODO: Provide some type
  gitlabUrl: any; // TODO: Provide some type
  gitlabToken: any; // TODO: Provide some type
  gitlabRunnerInstanceType: any; // TODO: Provide some type
  gitlabDockerImage: any; // TODO: Provide some type
  gitlabMaxBuilds: any; // TODO: Provide some type
  gitlabMaxConcurrentBuilds: any; // TODO: Provide some type
  gitlabIdleCount: any; // TODO: Provide some type
  gitlabIdleTime: any; // TODO: Provide some type
  gitlabOffPeakTimezone: any; // TODO: Provide some type
  gitlabOffPeakIdleCount: any; // TODO: Provide some type
  gitlabOffPeakIdleTime: any; // TODO: Provide some type
  gitlabCheckInterval: any; // TODO: Provide some type
  gitlabRunnerSpotInstance: any; // TODO: Provide some type
  gitlabRunnerSpotInstancePrice: any; // TODO: Provide some type
}

export class GitlabRunnerStack extends Stack {
  constructor(scope: Construct, id: string, props: GitlabRunnerStackProps) {
    super(scope, id, props);

    /*
     * #############################
     * ### GitLab Runner Manager ###
     * #############################
     */

    /*
     * ManagerSecurityGroup:
     * Type: 'AWS::EC2::SecurityGroup
     */
    const managerSecurityGroup = new SecurityGroup(
      this,
      "ManagerSecurityGroup",
      {
        vpc: props.vpc,
        description: "Security group for GitLab Runners Manager.",
      }
    );
    managerSecurityGroup.connections.allowFrom(
      Peer.ipv4("0.0.0.0/0"),
      Port.tcp(22),
      "SSH traffic"
    );

    /*
     * ManagerRole:
     * Type: 'AWS::IAM::Role'
     */
    const ec2ServicePrincipal = new ServicePrincipal("ec2.amazonaws.com", {});

    const managerRole = new Role(this, "ManagerRole", {
      assumedBy: ec2ServicePrincipal,
      managedPolicies: [
        ManagedPolicy.fromManagedPolicyArn(
          this,
          "arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforSSM",
          "arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforSSM"
        ),
      ],
      inlinePolicies: {
        Cache: PolicyDocument.fromJson({}), // TODO: Set this
        Runners: PolicyDocument.fromJson({}), // TODO: Set this
      },
    });

    /*
     * ManagerInstanceProfile:
     * Type: 'AWS::IAM::InstanceProfile'
     */
    const managerInstanceProfile = new CfnInstanceProfile( // TODO: refactor this low level code
      this,
      "ManagerInstanceProfile",
      {
        roles: [managerRole.roleName],
      }
    );

    /*
     * RunnersRole:
     * Type: 'AWS::IAM::Role'
     */

    const runnersRole = new Role(this, "RunnersRole", {
      assumedBy: ec2ServicePrincipal,
    });

    /*
     * RunnersInstanceProfile:
     * Type: 'AWS::IAM::InstanceProfile'
     */
    const runnersInstanceProfile = new CfnInstanceProfile( // TODO: refactor this low level code
      this,
      "RunnersInstanceProfile",
      {
        roles: [runnersRole.roleName],
      }
    );

    /* Manager:
     * Type: 'AWS::EC2::Instance'
     */
    const userData = new MultipartUserData({});
    userData.addCommands(
      `yum update -y aws-cfn-bootstrap`, // !/bin/bash -xe
      `/opt/aws/bin/cfn-init --stack '${this.stackName}' --region '${this.region}' --resource Manager --configsets default`, // Install the files and packages from the metadata
      `/opt/aws/bin/cfn-signal -e $? --stack '${this.region}' --region '${this.region}' --resource Manager` // Signal the status from cfn-init
    );

    const manager = new Instance(this, "Instance", {
      // TODO: finish this, set the missing values
      instanceType: new InstanceType(props.instanceTypeIdentifier),
      vpc: props.vpc,
      machineImage: props.machineImage,
      userData: userData,
      keyName: props.managerKeyPair, // TODO: set type in props
      securityGroup: managerSecurityGroup,
      vpcSubnets: props.vpcSubnet ?? {
        subnetType: SubnetType.PUBLIC,
      },
    });
    manager.node.tryRemoveChild("InstanceProfile"); // Remove default InstanceProfile
    manager.instance.iamInstanceProfile =
      managerInstanceProfile.instanceProfileName; // Reference our custom managerInstanceProfile: InstanceProfile

    const metadata = CloudFormationInit.fromConfigSets({
      configSets: {
        install: ["reposritories", "packages"],
        config: ["config"],
        // default: ["install", "config"], // TODO: REVIEW
      },
      configs: {
        repositories: new InitConfig([
          InitCommand.shellCommand(
            "curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.rpm.sh | bash", // 10-gitlab-runner
            { key: "10-gitlab-runner" }
          ),
        ]),
        packages: new InitConfig([
          InitPackage.yum("docker"),
          InitPackage.yum("gitlab-runner"),
          InitPackage.yum("tzdata"),
          InitFile.fromString(
            "/etc/cfn/cfn-hup.conf",
            `
              [main]
              stack=${this.stackName}
              region=${this.region}
            `,
            { owner: "root", group: "root", mode: "root" }
          ),
          InitFile.fromString(
            "/etc/cfn/hooks.d/cfn-auto-reloader.conf",
            `
              [cfn-auto-reloader-hook]
              triggers=post.update
              path=Resources.Manager.Metadata.AWS::CloudFormation::Init
              action=/opt/aws/bin/cfn-init -v --stack ${this.stackName} --region ${this.region} --resource Manager --configsets default
              runas=root
            `
          ),
          InitCommand.shellCommand(
            "curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.rpm.sh | bash", // 10-gitlab-runner
            { key: "10-gitlab-runner" }
          ),
          InitCommand.shellCommand(
            "gitlab-runner start", // 20-gitlab-runner-start
            { key: "20-gitlab-runner-start" }
          ),
          InitService.enable("cfn-hup", {
            enabled: true,
            ensureRunning: true,
            // files: [ '/etc/cfn/cfn-hup.conf', '/etc/cfn/hooks.d/cfn-auto-reloader.conf' ], TODO: REVIEW
          }),
        ]),
        config: new InitConfig([
          InitFile.fromString(
            "/etc/gitlab-runner/config.toml",
            `
            concurrent = ${props.gitlabMaxBuilds}
            check_interval = ${props.gitlabCheckInterval}
            [[runners]]
              name = "${this.stackName}"
              url = "${props.gitlabUrl}"
              token = "${props.gitlabToken}"
              executor = "docker+machine"
              environment = [
                "DOCKER_DRIVER=overlay2",
                "DOCKER_TLS_CERTDIR=/certs"
              ]
              [runners.docker]
                tls_verify = false
                image = "${props.gitlabDockerImage}"
                privileged = true
                disable_cache = false
                volumes = ["/certs/client", "/cache"]
                shm_size = 0
              [runners.cache]
                Type = "s3"
                Shared = true
              [runners.cache.s3]
                ServerAddress = "s3.${this.urlSuffix}"
                BucketName = "${props.cacheBucketName}"
                BucketLocation = "${this.region}"
              [runners.machine]
                IdleCount = ${props.gitlabIdleCount}
                IdleTime = ${props.gitlabIdleTime}
                MaxBuilds = ${props.gitlabMaxBuilds}
                MachineDriver = "amazonec2"
                MachineName = "gitlab-docker-machine-%s"
                MachineOptions = [
                  "amazonec2-instance-type=${props.gitlabRunnerInstanceType}",
                  "amazonec2-region=${this.region}",
                  "amazonec2-vpc-id=${props.vpc.vpcId}",
                  "amazonec2-zone=${props.availabilityZone}",
                  "amazonec2-subnet-id=${props.vpcSubnet}",
                  "amazonec2-security-group=${
                    this.stackName
                  }-RunnersSecurityGroup",
                  "amazonec2-use-private-address=true",
                  "amazonec2-iam-instance-profile=${
                    runnersInstanceProfile.logicalId
                  }"
                  ${
                    props.gitlabRunnerSpotInstance
                      ? "amazonec2-request-spot-instance=true"
                      : ""
                  } 
                  ${
                    props.gitlabRunnerSpotInstance
                      ? `amazonec2-spot-price=${props.gitlabRunnerSpotInstancePrice}`
                      : ""
                  }
                ]
                OffPeakTimezone = "${props.gitlabOffPeakTimezone}"
                OffPeakPeriods = ["* * 0-8,18-23 * * mon-fri *", "* * * * * sat,sun *"]
                OffPeakIdleCount = ${props.gitlabOffPeakIdleCount}
                OffPeakIdleTime = ${props.gitlabOffPeakIdleTime}
            `,
            {
              owner: "gitlab-runner",
              group: "gitlab-runner",
              mode: "000600",
            }
          ),
          InitFile.fromString(
            "/etc/rsyslog.d/25-gitlab-runner.conf",
            `
            :programname, isequal, "gitlab-runner" /var/log/gitlab-runner.log
          `,
            {
              owner: "root",
              group: "root",
              mode: "000644",
            }
          ),
          InitService.enable("gitlab-runner", {
            ensureRunning: true,
            enabled: true,
            // files: ['/etc/gitlab-runner/config.toml'] TODO: REVIEW
          }),
          InitService.enable("rsyslog", {
            ensureRunning: true,
            enabled: true,
            // files: ['/etc/rsyslog.d/25-gitlab-runner.conf'] TODO: REVIEW
          }),
        ]),
      },
    });

    /*
     * ManagerEIP:
     * Type: 'AWS::EC2::EIP'
     */
    const managerEip = new CfnEIP(this, "ManagerEIP", {
      // TODO: refactor this low level code
      domain: "vpc",
      instanceId: manager.instanceId,
    });

    /*
     * ######################
     * ### GitLab Runners ###
     * ######################
     */

    /*
     * RunnersSecurityGroup:
     * Type: 'AWS::EC2::SecurityGroup'
     */
    const runnersSecurityGroup = SecurityGroup.fromSecurityGroupId(
      this,
      "RunnersSecurityGroup",
      managerSecurityGroup.securityGroupId
    );

    runnersSecurityGroup.connections.allowFrom(
      Peer.anyIpv4(),
      Port.tcp(22),
      "SSH traffic from Manager"
    );
    runnersSecurityGroup.connections.allowFrom(
      Peer.anyIpv4(),
      Port.tcp(2376),
      "SSH traffic from Docker"
    );

    /*
     * ####################################
     * ### S3 Bucket for Runners' cache ###
     * ####################################
     */

    /* Transformation cacheExpirationInDays into expirationDate */
    const today = new Date().getDate();
    const cacheBucketExpirationDate = new Date();
    cacheBucketExpirationDate.setDate(today + props.cacheExpirationInDays);

    /* Enabled if not 0. If 0 - cache doesnt't expire. */
    const lifeCycleRuleEnabled = props.cacheExpirationInDays === 0;

    const cacheBucket = new Bucket(this, "GitlabRunnerCacheBucket", {
      bucketName: props.cacheBucketName,
      lifecycleRules: [
        {
          enabled: lifeCycleRuleEnabled,
          expirationDate: cacheBucketExpirationDate,
        },
      ],
      encryption: BucketEncryption.KMS,
      bucketKeyEnabled: true,
    });

    const cacheBucketDeployment = new BucketDeployment(
      this,
      "GitlabRunnerCacheBucketDeployment",
      {
        sources: [Source.asset], // TODO: configure it
        destinationBucket: cacheBucket,
        serverSideEncryption: ServerSideEncryption.AES_256,
      }
    );
  }
}
