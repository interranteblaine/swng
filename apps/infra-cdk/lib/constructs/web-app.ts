import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

export interface WebAppInfraProps {
  stage: string;
  zoneDomain: string;
  hostName?: string;
}

/**
 * Static web hosting for the React UI using S3 + CloudFront with a custom domain.
 * - Bucket is private (OAC), no direct public access
 * - CloudFront provides TLS and SPA routing (403/404 -> index.html)
 * - ACM certificate is DNS validated in us-east-1 (required for CloudFront)
 * - Route53 alias record points to the distribution
 *
 * Note: Content deployment (upload/invalidation) is handled by CI.
 */
export class WebAppInfra extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly fqdn: string;
  public readonly zone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: WebAppInfraProps) {
    super(scope, id);

    const { stage, zoneDomain, hostName } = props;

    this.fqdn =
      hostName && hostName.length > 0
        ? `${hostName}.${zoneDomain}`
        : zoneDomain;

    this.zone = route53.HostedZone.fromLookup(this, `UiZone-${stage}`, {
      domainName: zoneDomain,
    });

    // Certificate for CloudFront (must be in us-east-1; using standard Certificate with DNS validation).
    const certificate = new acm.Certificate(this, `UiCert-${stage}`, {
      domainName: this.fqdn,
      validation: acm.CertificateValidation.fromDns(this.zone),
    });

    this.bucket = new s3.Bucket(this, `UiBucket-${stage}`, {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const responseHeaders = cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS;

    this.distribution = new cloudfront.Distribution(this, `UiDist-${stage}`, {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: responseHeaders,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
      },
      defaultRootObject: "index.html",
      certificate,
      domainNames: [this.fqdn],
      enableLogging: false,
      errorResponses: [
        // SPA: serve index.html for 403/404
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(1),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(1),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new route53.ARecord(this, `UiAlias-${stage}`, {
      zone: this.zone,
      recordName: hostName && hostName.length > 0 ? hostName : undefined,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });

    new CfnOutput(this, `UiUrl-${stage}`, {
      value: `https://${this.fqdn}`,
      exportName: `UiUrl-${stage}`,
    });

    new CfnOutput(this, `UiDistributionDomainName-${stage}`, {
      value: this.distribution.domainName,
      exportName: `UiDistributionDomainName-${stage}`,
    });

    new CfnOutput(this, `UiBucketName-${stage}`, {
      value: this.bucket.bucketName,
      exportName: `UiBucketName-${stage}`,
    });
  }
}
