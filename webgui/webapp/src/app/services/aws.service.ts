// src/app/services/aws-pricing.service.ts
import { Injectable } from '@angular/core';
import * as AWS from 'aws-sdk';
import { forkJoin, from, map, Observable } from 'rxjs';
import { environment } from 'src/environments/environment';

@Injectable({
  providedIn: 'root',
})
export class AwsService {
  private pricing: AWS.Pricing;

  constructor() {
    // Initialize AWS Pricing API
    // Pricing API is only available in 'us-east-1' region
    this.pricing = new AWS.Pricing({
      region: 'us-east-1',
      credentials: {
        accessKeyId: environment.pricingCredentials.accessKeyId,
        secretAccessKey: environment.pricingCredentials.secretAccessKey,
      },
    });
  }

  private getPriceDimensions(data: AWS.Pricing.Types.GetProductsResponse) {
    const priceList = data.PriceList;

    if (priceList && priceList.length > 0) {
      const priceData = priceList[0];
      const terms = (priceData as any).terms.OnDemand;
      const termKey = Object.keys(terms)[0];
      const priceDimensions = terms[termKey].priceDimensions;
      return priceDimensions;
    }

    return null;
  }

  private parseInstancePricingData(
    data: AWS.Pricing.Types.GetProductsResponse,
  ): number | null {
    const priceDimensions = this.getPriceDimensions(data);

    if (!priceDimensions) return null;

    const price =
      priceDimensions[Object.keys(priceDimensions)[0]].pricePerUnit.USD;

    return parseFloat(price);
  }

  private parseStoragePricingData(
    data: AWS.Pricing.Types.GetProductsResponse,
    volume: number,
  ): number | null {
    const priceDimensions = this.getPriceDimensions(data);

    if (!priceDimensions) return null;

    const filteredPricing: any = Object.values(priceDimensions).find(
      (pricing: any) => {
        const endRangeValue = pricing.endRange;

        // Validate the volume against the price range (including "Inf" for unlimited range)
        if (endRangeValue === 'Inf') {
          return parseInt(pricing.beginRange) <= volume;
        } else {
          return (
            parseInt(endRangeValue) >= volume &&
            parseInt(pricing.beginRange) <= volume
          );
        }
      },
    );

    if (filteredPricing) {
      return filteredPricing.pricePerUnit.USD;
    }

    return null;
  }

  // Fetch AmazonSageMaker instance pricing
  private async getInstancePricing(
    instanceType: string,
  ): Promise<number | null> {
    const params: AWS.Pricing.GetProductsRequest = {
      MaxResults: 10,
      ServiceCode: 'AmazonSageMaker',
      Filters: [
        { Type: 'TERM_MATCH', Field: 'regionCode', Value: 'ap-southeast-3' },
        {
          Type: 'TERM_MATCH',
          Field: 'component',
          Value: 'studio-jupyterlab',
        },
        {
          Type: 'TERM_MATCH',
          Field: 'instanceType',
          Value: instanceType,
        },
      ],
    };

    try {
      const data = await this.pricing.getProducts(params).promise();
      return this.parseInstancePricingData(data);
    } catch (error) {
      console.error('Error fetching EC2 pricing:', error);
      return null;
    }
  }

  // Fetch AmazonS3 volume pricing
  private async getVolumePricing(volumeSize: number): Promise<number | null> {
    const params: AWS.Pricing.GetProductsRequest = {
      MaxResults: 10,
      ServiceCode: 'AmazonS3',
      Filters: [
        { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Storage' },
        {
          Type: 'TERM_MATCH',
          Field: 'regionCode',
          Value: 'ap-southeast-3',
        },
        { Type: 'TERM_MATCH', Field: 'volumeType', Value: 'Standard' },
        { Type: 'TERM_MATCH', Field: 'storageClass', Value: 'General Purpose' },
      ],
    };

    try {
      const data = await this.pricing.getProducts(params).promise();
      return this.parseStoragePricingData(data, volumeSize);
    } catch (error) {
      console.error('Error fetching EBS volume pricing:', error);
      return null;
    }
  }

  private calculateMonthlyCost(intancePrice: number): number {
    const hoursPerDay = 24;
    const daysPerMonth = 30;
    const hoursPerMonth = hoursPerDay * daysPerMonth;

    // Multiply price per hour by hours in a month
    const monthlyCost = intancePrice * hoursPerMonth;
    return monthlyCost;
  }

  calculateTotalPricePerMonth(
    instanceType: string,
    volumeSize: number,
  ): Observable<number> {
    return forkJoin({
      instancePrice: from(this.getInstancePricing(instanceType)),
      volumePrice: from(this.getVolumePricing(volumeSize)),
    }).pipe(
      map(({ instancePrice, volumePrice }) => {
        const volumePricePerMonth = (volumePrice || 0) * volumeSize;
        const instancePricePerMonth = this.calculateMonthlyCost(
          instancePrice || 0,
        );
        return parseFloat(
          (volumePricePerMonth + instancePricePerMonth).toFixed(2),
        );
      }),
    );
  }
}